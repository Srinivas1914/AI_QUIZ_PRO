import json
from django.test import Client, TestCase


class DjangoMigrationSmokeTests(TestCase):
    def setUp(self):
        self.client = Client()

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
