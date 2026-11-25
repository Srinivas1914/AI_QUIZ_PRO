import json
import tempfile
from pathlib import Path
from django.test import Client, TestCase
import quiz_app.db as app_db


class DjangoMigrationSmokeTests(TestCase):
    def setUp(self):
        self.client = Client()
        self._orig_data_file = app_db.DATA_FILE
        self._tmp_dir = tempfile.TemporaryDirectory()
        app_db.DATA_FILE = Path(self._tmp_dir.name) / 'test_data.json'
        app_db._sync_data = {}
        app_db._initialized = False

    def tearDown(self):
        app_db.DATA_FILE = self._orig_data_file
        app_db._sync_data = {}
        app_db._initialized = False
        self._tmp_dir.cleanup()

    def test_all_html_pages_render_with_bootstrap_and_compiled_ts(self):
        routes = [
            '/',
            '/superadmin',
            '/admin',
            '/participant',
            '/team/Alpha',
            '/camera-monitor.html',
            '/live-feed.html',
        ]
        for route in routes:
            resp = self.client.get(route)
            self.assertEqual(resp.status_code, 200, f'Failed route: {route}')
            html = resp.content.decode('utf-8')
            self.assertIn('bootstrap@5.3.3', html)
            self.assertIn('/static/js/storage.js', html)
            self.assertNotIn('/socket.io/socket.io.js', html)

    def test_auth_sync_and_payment_endpoints(self):
        # 1. SuperAdmin login
        login_resp = self.client.post(
            '/api/login',
            data=json.dumps({'username': 'srinivas', 'password': 'sri@1119'}),
            content_type='application/json',
        )
        self.assertEqual(login_resp.status_code, 200)
        login_data = login_resp.json()
        self.assertTrue(login_data['success'])
        self.assertTrue(login_data['session']['isSuper'])
        token = login_data['token']
        auth_header = {'HTTP_AUTHORIZATION': f'Bearer {token}'}

        # 2. Register + login + delete user
        test_user = {
            'id': '_test_user_999',
            'name': 'Test User',
            'roll': 'R999',
            'username': 'testuser999',
            'password': 'pass1234',
            'college': 'Test College',
            'dept': 'CSE',
            'year': '3',
            'role': 'user',
        }
        reg_resp = self.client.post('/api/register', data=json.dumps(test_user), content_type='application/json')
        self.assertEqual(reg_resp.status_code, 200)
        self.assertTrue(reg_resp.json()['success'])

        user_login = self.client.post(
            '/api/login',
            data=json.dumps({'username': 'testuser999', 'password': 'pass1234'}),
            content_type='application/json',
        )
        self.assertEqual(user_login.status_code, 200)
        self.assertTrue(user_login.json()['success'])

        del_resp = self.client.post(
            '/api/users/delete',
            data=json.dumps({'id': '_test_user_999'}),
            content_type='application/json',
            **auth_header,
        )
        self.assertEqual(del_resp.status_code, 200)
        self.assertTrue(del_resp.json()['success'])

        # 3. Sync push, state, cmd
        push_resp = self.client.post(
            '/api/sync/push',
            data=json.dumps({'key': 'sq_test_key', 'val': '{"ok":true}', '_ts': 123456789}),
            content_type='application/json',
            **auth_header,
        )
        self.assertEqual(push_resp.status_code, 200)

        state_resp = self.client.get('/api/sync/state?since=0', **auth_header)
        self.assertEqual(state_resp.status_code, 200)
        self.assertIn('sq_test_key', state_resp.json()['updates'])

        cmd_resp = self.client.post(
            '/api/sync/cmd',
            data=json.dumps({'type': 'msg', 'target': 'all', 'msg': 'hello'}),
            content_type='application/json',
            **auth_header,
        )
        self.assertEqual(cmd_resp.status_code, 200)

        # 4. Payment settings & payments & admin perf
        ps_post = self.client.post(
            '/py-api/payment-settings',
            data=json.dumps({
                'amount': 299,
                'quizzesPerPayment': 3,
                'validityDays': 15,
                'discountPercent': 10,
                'enabled': False,
                'aiPaymentRequired': False,
                'aiFreeLimit': 0,
                'aiPrice': 25,
            }),
            content_type='application/json',
            **auth_header,
        )
        self.assertEqual(ps_post.status_code, 200)
        self.assertTrue(ps_post.json()['success'])

        ps_get = self.client.get('/py-api/payment-settings', **auth_header)
        self.assertEqual(ps_get.status_code, 200)
        self.assertTrue(ps_get.json()['success'])
        self.assertEqual(ps_get.json()['settings']['amount'], 299)
        self.assertEqual(ps_get.json()['settings']['enabled'], False)
        self.assertEqual(ps_get.json()['settings']['aiPaymentRequired'], False)
        self.assertEqual(ps_get.json()['settings']['aiFreeLimit'], 0)

        ip_get = self.client.get('/api/client-ip')
        self.assertEqual(ip_get.status_code, 200)
        self.assertTrue(ip_get.json()['success'])

        pay_get = self.client.get('/py-api/payments', **auth_header)
        self.assertEqual(pay_get.status_code, 200)
        self.assertTrue(pay_get.json()['success'])

        perf_get = self.client.get('/api/admin-perf')
        self.assertEqual(perf_get.status_code, 200)
        self.assertTrue(perf_get.json()['success'])

    def test_enterprise_billing_platform_apis(self):
        login_resp = self.client.post(
            '/api/login',
            data=json.dumps({'username': 'srinivas', 'password': 'sri@1119'}),
            content_type='application/json',
        )
        token = login_resp.json()['token']
        auth = {'HTTP_AUTHORIZATION': f'Bearer {token}'}

        # Overview & Analytics
        ov = self.client.get('/api/billing/overview', **auth)
        self.assertEqual(ov.status_code, 200)
        self.assertIn('mrr', ov.json()['analytics'])
        self.assertIn('arr', ov.json()['analytics'])

        # AI Credits Wallet
        w_post = self.client.post(
            '/api/billing/ai-wallet',
            data=json.dumps({'userId': 'admin_test_1', 'delta': 15, 'reason': 'Unit test grant'}),
            content_type='application/json',
            **auth,
        )
        self.assertEqual(w_post.status_code, 200)
        self.assertEqual(w_post.json()['wallet']['remainingCredits'], 15)

        w_get = self.client.get('/api/billing/ai-wallet', **auth)
        self.assertEqual(w_get.status_code, 200)
        self.assertTrue(w_get.json()['success'])

        # Coupons: create, bulk, validate
        c_post = self.client.post(
            '/api/billing/coupons',
            data=json.dumps({'code': 'ENTERPRISE25', 'discountType': 'percent', 'discountValue': 25}),
            content_type='application/json',
            **auth,
        )
        self.assertEqual(c_post.status_code, 200)

        c_val = self.client.post(
            '/api/billing/coupons/validate',
            data=json.dumps({'code': 'ENTERPRISE25', 'amount': 1000}),
            content_type='application/json',
            **auth,
        )
        self.assertEqual(c_val.status_code, 200)
        self.assertTrue(c_val.json()['success'])
        self.assertEqual(c_val.json()['finalAmount'], 750.0)

        c_bulk = self.client.post(
            '/api/billing/coupons/bulk',
            data=json.dumps({'prefix': 'BULK', 'count': 3, 'discountType': 'fixed', 'discountValue': 50}),
            content_type='application/json',
            **auth,
        )
        self.assertEqual(c_bulk.status_code, 200)
        self.assertEqual(c_bulk.json()['count'], 3)

        # Risk, Notifications, Roles, Refunds, Tickets, Address, Audit, Portal
        self.assertEqual(self.client.get('/api/billing/risk', **auth).status_code, 200)
        self.assertEqual(self.client.get('/api/billing/notifications', **auth).status_code, 200)
        self.assertEqual(self.client.get('/api/billing/roles', **auth).status_code, 200)
        self.assertEqual(self.client.get('/api/billing/portal', **auth).status_code, 200)
        self.assertEqual(self.client.get('/api/billing/audit/export', **auth).status_code, 200)

        tkt = self.client.post(
            '/api/billing/tickets',
            data=json.dumps({'subject': 'Invoice inquiry', 'message': 'Need GST copy'}),
            content_type='application/json',
            **auth,
        )
        self.assertEqual(tkt.status_code, 200)
        self.assertTrue(tkt.json()['success'])

        addr = self.client.post(
            '/api/billing/address',
            data=json.dumps({'company': 'SACET', 'gstin': '37ABCDE1234F1Z5', 'address': 'Campus Rd', 'city': 'Chirala'}),
            content_type='application/json',
            **auth,
        )
        self.assertEqual(addr.status_code, 200)
        self.assertEqual(addr.json()['address']['gstin'], '37ABCDE1234F1Z5')

        # Seed a payment and verify GST PDF invoice generation
        from quiz_app.db import insert_collection_item
        insert_collection_item('payments', {
            'order_id': 'order_pdf_test_1',
            'payment_id': 'pay_pdf_test_1',
            'user_id': 'Super Admin',
            'amount': 49900,
            'status': 'paid',
            'type': 'quiz_start',
            'created_at': '2026-11-25T10:00:00+00:00',
        })
        pdf_resp = self.client.get('/api/billing/invoice/order_pdf_test_1.pdf', **auth)
        self.assertEqual(pdf_resp.status_code, 200)
        self.assertEqual(pdf_resp['Content-Type'], 'application/pdf')
        self.assertTrue(pdf_resp.content.startswith(b'%PDF'))

    def test_strict_ai_limit_and_payment_revalidation_flow(self):
        from unittest.mock import patch, MagicMock
        from quiz_app.db import insert_collection_item

        # 1. SuperAdmin configures strict limits: aiPaymentRequired=True, aiFreeLimit=0, aiCreditsPerPayment=3, maxQuestionsPerGen=10
        sa_login = self.client.post('/api/login', data=json.dumps({'username': 'srinivas', 'password': 'sri@1119'}), content_type='application/json')
        sa_auth = {'HTTP_AUTHORIZATION': f"Bearer {sa_login.json()['token']}"}
        self.client.post(
            '/py-api/payment-settings',
            data=json.dumps({
                'amount': 499,
                'enabled': True,
                'aiPaymentRequired': True,
                'aiFreeLimit': 0,
                'aiPrice': 20,
                'aiCreditsPerPayment': 3,
                'maxQuestionsPerGen': 10,
                'groqApiKey': 'gsk_test_mock_key',
            }),
            content_type='application/json',
            **sa_auth,
        )

        # 2. Register & login a normal admin
        self.client.post('/api/register', data=json.dumps({
            'id': '_adm_limit_1',
            'name': 'Limit Admin',
            'username': 'limitadmin',
            'password': 'pass1234',
            'role': 'admin',
            'college': 'Test Inst',
            'currentQuizId': 'QZLIMIT1',
        }), content_type='application/json')
        adm_login = self.client.post('/api/login', data=json.dumps({'username': 'limitadmin', 'password': 'pass1234'}), content_type='application/json')
        adm_auth = {'HTTP_AUTHORIZATION': f"Bearer {adm_login.json()['token']}"}

        # 3. Exceeding maxQuestionsPerGen is blocked
        over_max = self.client.post('/py-api/ai/generate', data=json.dumps({'topic': 'Math', 'count': 25}), content_type='application/json', **adm_auth)
        self.assertEqual(over_max.status_code, 400)

        # 4. Requesting AI generation with 0 free & 0 paid credits returns requirePayment=True
        need_pay = self.client.post('/py-api/ai/generate', data=json.dumps({'topic': 'Physics', 'count': 3}), content_type='application/json', **adm_auth)
        self.assertEqual(need_pay.status_code, 200)
        self.assertTrue(need_pay.json()['requirePayment'])
        self.assertEqual(need_pay.json()['price'], 20)

        # 5. Quiz start via sync/push without activation is blocked (402)
        sync_block = self.client.post(
            '/api/sync/push',
            data=json.dumps({'key': 'sq_quiz_QZLIMIT1', 'val': json.dumps({'status': 'running'})}),
            content_type='application/json',
            **adm_auth,
        )
        self.assertEqual(sync_block.status_code, 402)

        # 6. Mark-failed order does NOT allocate credits
        insert_collection_item('payments', {
            'order_id': 'order_fail_check',
            'user_id': '_adm_limit_1',
            'amount': 2000,
            'status': 'created',
            'topic': 'Physics',
            'count': 3,
        })
        self.client.post('/py-api/payment/mark-failed', data=json.dumps({'order_id': 'order_fail_check', 'reason': 'User cancelled'}), content_type='application/json', **adm_auth)
        still_need = self.client.post('/py-api/ai/generate', data=json.dumps({'topic': 'Physics', 'count': 3}), content_type='application/json', **adm_auth)
        self.assertTrue(still_need.json()['requirePayment'])

        # 7. Simulate verified Razorpay payment -> allocates 3 credits & generates questions
        insert_collection_item('payments', {
            'order_id': 'order_ok_check',
            'user_id': '_adm_limit_1',
            'amount': 2000,
            'status': 'created',
            'topic': 'Physics',
            'count': 2,
            'difficulty': 'medium',
        })
        mock_rzp = MagicMock()
        mock_rzp.utility.verify_payment_signature.return_value = True
        mock_gen = {'questions': [{'text': 'Q1?', 'options': ['A', 'B', 'C', 'D'], 'correct': [0], 'explanation': 'E'}], 'model': 'llama-3.3-70b-versatile'}
        with patch('quiz_app.api_views._get_rzp_client', return_value=(mock_rzp, 'rzp_test_x')), \
             patch('quiz_app.api_views.generate_groq_questions', return_value=mock_gen):
            ver_resp = self.client.post(
                '/py-api/payment/verify',
                data=json.dumps({
                    'razorpay_order_id': 'order_ok_check',
                    'razorpay_payment_id': 'pay_ok_check',
                    'razorpay_signature': 'sig_ok',
                }),
                content_type='application/json',
                **adm_auth,
            )
            self.assertEqual(ver_resp.status_code, 200)
            self.assertTrue(ver_resp.json()['success'])
            self.assertEqual(ver_resp.json()['creditsAdded'], 3)
            self.assertEqual(ver_resp.json()['paidCreditsRemaining'], 2)

            # 8. Idempotency check: re-verifying same order is rejected
            dup_resp = self.client.post(
                '/py-api/payment/verify',
                data=json.dumps({
                    'razorpay_order_id': 'order_ok_check',
                    'razorpay_payment_id': 'pay_ok_check',
                    'razorpay_signature': 'sig_ok',
                }),
                content_type='application/json',
                **adm_auth,
            )
            self.assertEqual(dup_resp.status_code, 400)

            # 9. Subsequent AI generation succeeds without payment using remaining credits
            next_gen = self.client.post('/py-api/ai/generate', data=json.dumps({'topic': 'Chemistry', 'count': 2}), content_type='application/json', **adm_auth)
            self.assertEqual(next_gen.status_code, 200)
            self.assertTrue(next_gen.json()['success'])
            self.assertEqual(next_gen.json()['paidCreditsRemaining'], 1)

        # 10. Coupon discount applies to quiz-start order & increments usedCount on verify
        from .db import upsert_collection_item, get_collection_items
        self.client.post('/py-api/payment-settings', data=json.dumps({'amount': 500, 'discountPercent': 0, 'enabled': True, 'quizzesPerPayment': 2, 'validityDays': 30}), content_type='application/json', **sa_auth)
        upsert_collection_item('coupons', 'code', 'SAVE50', {
            'code': 'SAVE50',
            'discountType': 'percent',
            'discountValue': 50,
            'maxRedemptions': 10,
            'usedCount': 0,
            'active': True,
        })
        mock_rzp_q = MagicMock()
        mock_rzp_q.order.create.return_value = {'id': 'order_coupon_1', 'amount': 25000, 'currency': 'INR'}
        mock_rzp_q.utility.verify_payment_signature.return_value = True
        with patch('quiz_app.api_views._get_rzp_client', return_value=(mock_rzp_q, 'rzp_test_x')):
            ord_resp = self.client.post(
                '/py-api/quiz-start/create_order',
                data=json.dumps({'quizId': 'QZCOUPON', 'couponCode': 'SAVE50'}),
                content_type='application/json',
                **adm_auth,
            )
            self.assertEqual(ord_resp.status_code, 200)
            self.assertTrue(ord_resp.json()['success'])
            self.assertEqual(mock_rzp_q.order.create.call_args.kwargs['data']['amount'], 25000)

            ver_q = self.client.post(
                '/py-api/quiz-start/verify',
                data=json.dumps({
                    'razorpay_order_id': 'order_coupon_1',
                    'razorpay_payment_id': 'pay_coupon_1',
                    'razorpay_signature': 'sig_coupon',
                }),
                content_type='application/json',
                **adm_auth,
            )
            self.assertEqual(ver_q.status_code, 200)
            self.assertTrue(ver_q.json()['success'])
            from .db import get_collection_items
            coupons = get_collection_items('coupons')
            save50 = next((c for c in coupons if c.get('code') == 'SAVE50'), None)
            self.assertIsNotNone(save50)
            self.assertEqual(int(save50.get('usedCount', 0)), 1)
