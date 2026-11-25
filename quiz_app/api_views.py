import json
import os
import random
import re
import string
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import razorpay
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .ai_service import generate_groq_questions
from .auth_utils import create_token, get_current_user
from .db import (
    delete_user_from_storage,
    get_all_sync_data,
    get_collection_items,
    get_payment_config,
    get_sync_value,
    insert_collection_item,
    save_payment_config,
    save_sync_data,
    upsert_collection_item,
)
from .sync_service import get_sync_state_for_user, handle_sync_push, push_event


def _json_body(request):
    if not request.body:
        return {}
    try:
        return json.loads(request.body.decode('utf-8'))
    except Exception:
        return {}


def _get_rzp_client():
    key_id = os.getenv('RAZORPAY_KEY_ID', '')
    key_sec = os.getenv('RAZORPAY_KEY_SECRET', '')
    if key_id and key_sec and not key_id.startswith('your_'):
        return razorpay.Client(auth=(key_id, key_sec)), key_id
    return None, None


def _iso_now():
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(dt_val):
    if not dt_val:
        return None
    if isinstance(dt_val, datetime):
        return dt_val if dt_val.tzinfo else dt_val.replace(tzinfo=timezone.utc)
    try:
        s = str(dt_val).replace('Z', '+00:00')
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _as_bool(val, default=True):
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.strip().lower() in ('true', '1', 'yes', 'on')
    return bool(val)


def _as_int(val, default=0):
    if val is None or val == '':
        return default
    try:
        return int(val)
    except Exception:
        return default


@require_http_methods(['GET'])
def api_client_ip(request):
    xff = request.META.get('HTTP_X_FORWARDED_FOR', '')
    ip = xff.split(',')[0].strip() if xff else request.META.get('REMOTE_ADDR', '127.0.0.1')
    return JsonResponse({'success': True, 'ip': ip or '127.0.0.1'})


# ─── AUTHENTICATION ────────────────────────────────────────────
@csrf_exempt
@require_http_methods(['POST'])
def api_login(request):
    body = _json_body(request)
    username = (body.get('username') or '').strip()
    password = (body.get('password') or '').strip()
    quiz_id = (body.get('quizId') or '').strip()

    settings_raw = get_sync_value('sq_settings')
    settings_obj = json.loads(settings_raw) if settings_raw else {}
    super_u = (settings_obj.get('adminUsername') or '').strip() or 'srinivas'
    super_p = (settings_obj.get('adminPassword') or '').strip() or 'sri@1119'

    if username == super_u and password == super_p:
        session = {'role': 'admin', 'isSuper': True, 'name': 'Super Admin'}
        token = create_token(session)
        return JsonResponse({'success': True, 'token': token, 'session': session})

    users_raw = get_sync_value('sq_users', '[]') or '[]'
    try:
        users = json.loads(users_raw)
    except Exception:
        users = []

    user = next((u for u in users if u.get('username') == username and u.get('password') == password), None)
    if user:
        qid = quiz_id or user.get('currentQuizId')
        claims = {
            'userId': user.get('id'),
            'role': user.get('role'),
            'name': user.get('name'),
            'roll': user.get('roll'),
            'college': user.get('college'),
            'quizId': qid,
        }
        token = create_token(claims)
        session = {
            'role': user.get('role'),
            'userId': user.get('id'),
            'name': user.get('name'),
            'roll': user.get('roll'),
            'college': user.get('college'),
            'quizId': user.get('currentQuizId') or quiz_id,
        }
        return JsonResponse({'success': True, 'token': token, 'session': session})

    all_sync = get_all_sync_data()
    team_keys = [k for k in all_sync.keys() if k.startswith('sq_teams')]

    if not quiz_id:
        for tk in team_keys:
            try:
                pot = json.loads(all_sync.get(tk) or '[]')
                if any(t.get('username') == username or t.get('name') == username for t in pot):
                    return JsonResponse({'success': False, 'message': 'ENTER QUIZ ID'}, status=401)
            except Exception:
                pass

    teams_key = f'sq_teams_{quiz_id}' if quiz_id else 'sq_teams'
    teams = json.loads(get_sync_value(teams_key, '[]') or '[]')
    team = next(
        (t for t in teams if (t.get('username') == username or t.get('name') == username) and t.get('password') == password),
        None,
    )

    if not team and quiz_id:
        for tk in team_keys:
            try:
                pot = json.loads(all_sync.get(tk) or '[]')
                if any(t.get('username') == username or t.get('name') == username for t in pot):
                    return JsonResponse({'success': False, 'message': 'ENTER ACTIVE QUIZ ID'}, status=401)
            except Exception:
                pass

    if team:
        claims = {'teamId': team.get('id'), 'role': 'team', 'name': team.get('name'), 'quizId': quiz_id}
        token = create_token(claims)
        return JsonResponse({'success': True, 'token': token, 'session': claims})

    return JsonResponse({'success': False, 'message': 'Invalid username or password'}, status=401)


@csrf_exempt
@require_http_methods(['POST'])
def api_register(request):
    new_user = _json_body(request)
    if not new_user or not new_user.get('username'):
        return JsonResponse({'success': False, 'message': 'Invalid user data'}, status=400)

    users = json.loads(get_sync_value('sq_users', '[]') or '[]')
    users.append(new_user)
    save_sync_data('sq_users', json.dumps(users))
    return JsonResponse({'success': True})


@csrf_exempt
@require_http_methods(['POST'])
def api_delete_user(request):
    body = _json_body(request)
    user_id = body.get('id')
    if not user_id:
        return JsonResponse({'success': False, 'message': 'User ID required'}, status=400)

    user = get_current_user(request)
    if not user and body.get('token'):
        from .auth_utils import decode_token
        user = decode_token(body.get('token'))

    if not user or user.get('role') != 'admin':
        return JsonResponse({'success': False, 'message': 'Admin authorization required'}, status=403)

    updated = delete_user_from_storage(user_id)
    return JsonResponse({'success': True, 'count': len(updated)})


# ─── SYNC ENGINE ───────────────────────────────────────────────
@require_http_methods(['GET'])
def api_sync_state(request):
    user = get_current_user(request) or {}
    try:
        since_ts = int(request.GET.get('since', '0') or '0')
    except ValueError:
        since_ts = 0
    return JsonResponse(get_sync_state_for_user(user, since_ts))


@csrf_exempt
@require_http_methods(['POST'])
def api_sync_push(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'success': False, 'message': 'Unauthorized'}, status=401)
    body = _json_body(request)
    key = body.get('key')
    if not key:
        return JsonResponse({'success': False, 'message': 'Key required'}, status=400)
    ts = int(body.get('_ts') or time.time() * 1000)
    # Enforce Quiz Start payment activation on backend for non-superadmins
    if key.startswith('sq_quiz') and not user.get('isSuper', False):
        try:
            q_obj = json.loads(body.get('val')) if isinstance(body.get('val'), str) else (body.get('val') or {})
            if isinstance(q_obj, dict) and q_obj.get('status') in ('round_intro', 'running'):
                cfg = get_payment_config()
                if cfg.get('enabled', True):
                    qid = key.replace('sq_quiz_', '') if key.startswith('sq_quiz_') else (user.get('quizId') or 'LOCAL')
                    admin_id = user.get('userId') or user.get('name')
                    activations = get_collection_items('quiz_activations')
                    if not any(a.get('adminId') == admin_id and a.get('quizId') == qid for a in activations):
                        return JsonResponse({
                            'success': False,
                            'requirePayment': True,
                            'message': 'Quiz activation license required before starting quiz.',
                        }, status=402)
        except Exception:
            pass
    try:
        res = handle_sync_push(key, body.get('val'), user, ts)
        return JsonResponse({'success': True, **res})
    except PermissionError as e:
        return JsonResponse({'success': False, 'message': str(e)}, status=403)
    except Exception as e:
        return JsonResponse({'success': False, 'message': str(e)}, status=500)


@csrf_exempt
@require_http_methods(['POST'])
def api_sync_cmd(request):
    user = get_current_user(request) or {}
    body = _json_body(request)
    evt = push_event('admin_cmd', body, sender=user.get('name', 'Admin'))
    return JsonResponse({'success': True, 'eventId': evt['id']})


@csrf_exempt
@require_http_methods(['POST'])
def api_sync_audio(request):
    user = get_current_user(request) or {}
    body = _json_body(request)
    evt = push_event('admin_audio', body, sender=user.get('name', 'Admin'))
    return JsonResponse({'success': True, 'eventId': evt['id']})


# ─── REPORTS & ADMIN PERFORMANCE ───────────────────────────────
@csrf_exempt
@require_http_methods(['POST'])
def api_reports_save(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'success': False, 'message': 'No token'}, status=401)
    if user.get('role') != 'admin':
        return JsonResponse({'success': False, 'message': 'Forbidden'}, status=403)

    report = _json_body(request)
    report['adminId'] = user.get('userId') or user.get('id') or user.get('name')
    upsert_collection_item('reports', 'id', report.get('id'), report)
    return JsonResponse({'success': True})


@require_http_methods(['GET'])
def api_reports_list(request, quiz_id):
    all_reports = get_collection_items('reports')
    filtered = [r for r in all_reports if r.get('quizId') == quiz_id]
    filtered.sort(key=lambda x: x.get('timestamp', 0), reverse=True)
    return JsonResponse({'success': True, 'reports': filtered})


@require_http_methods(['GET'])
def api_admin_perf(request):
    reports = json.loads(get_sync_value('sq_reports', '[]') or '[]')
    admins = {}
    for r in reports:
        name = r.get('adminName') or 'Unknown Admin'
        if name not in admins:
            admins[name] = {
                'name': name,
                'college': r.get('college') or 'Unknown',
                'quizCount': 0,
                'totalTeams': 0,
                'lastActivity': 0,
            }
        admins[name]['quizCount'] += 1
        admins[name]['totalTeams'] += len((r.get('data') or {}).get('teams', []))
        ts = r.get('timestamp', 0)
        if ts > admins[name]['lastActivity']:
            admins[name]['lastActivity'] = ts
    return JsonResponse({'success': True, 'data': list(admins.values())})


# ─── AI GENERATION ─────────────────────────────────────────────
_usage_lock = threading.Lock()
_payment_lock = threading.Lock()


@csrf_exempt
@require_http_methods(['POST'])
def api_ai_test_key(request):
    user = get_current_user(request)
    if not user or not user.get('isSuper'):
        return JsonResponse({'success': False, 'detail': 'Forbidden'}, status=403)
    body = _json_body(request)
    from .ai_service import fetch_available_groq_models, get_groq_api_key
    key = (body.get('groqApiKey') or '').strip() or get_groq_api_key()
    if not key:
        return JsonResponse({'success': False, 'message': 'No Groq API key provided.'}, status=400)
    try:
        import requests as req_lib
        r = req_lib.get('https://api.groq.com/openai/v1/models', headers={'Authorization': f'Bearer {key}'}, timeout=10)
        if r.status_code == 200:
            models = fetch_available_groq_models(key)
            return JsonResponse({'success': True, 'message': f'Groq API Key connected! {len(models)} active models found.', 'models': models[:10]})
        return JsonResponse({'success': False, 'message': f'Groq rejected key (HTTP {r.status_code}). Check your key at console.groq.com.'}, status=400)
    except Exception as e:
        return JsonResponse({'success': False, 'message': f'Connection error: {e}'}, status=502)


@csrf_exempt
@require_http_methods(['POST'])
def api_ai_generate_direct(request):
    return py_ai_generate(request)


@csrf_exempt
@require_http_methods(['POST'])
def py_ai_generate(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'success': False, 'detail': 'Authentication required', 'message': 'Authentication required'}, status=401)

    body = _json_body(request)
    topic = (body.get('topic') or '').strip()
    count_raw = body.get('count')
    difficulty = body.get('difficulty', 'medium')
    if not topic or not count_raw:
        return JsonResponse({'success': False, 'detail': 'Topic and count required', 'message': 'Topic and count required'}, status=400)

    count = _as_int(count_raw, 5)
    user_id = user.get('userId') or user.get('name') or 'unknown'
    is_super = bool(user.get('isSuper', False))

    config = get_payment_config()
    ai_payment_req = bool(config.get('aiPaymentRequired', True))
    ai_free_limit = int(config.get('aiFreeLimit', 0))
    ai_price = int(config.get('aiPrice', 10))
    ai_credits_pack = int(config.get('aiCreditsPerPayment', 5))
    max_q_per_gen = int(config.get('maxQuestionsPerGen', 20))
    ai_daily_limit = int(config.get('aiDailyLimit', 50))

    if not is_super and count > max_q_per_gen:
        return JsonResponse({
            'success': False,
            'detail': f'Requested {count} questions exceeds SuperAdmin limit of {max_q_per_gen} per generation.',
            'message': f'Maximum {max_q_per_gen} questions allowed per generation.',
        }, status=400)

    from .billing_service import get_or_create_wallet, push_notification
    today_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    deducted_mode = None  # 'free' | 'paid' | None

    with _usage_lock:
        usage_items = get_collection_items('ai_usage')
        user_record = next((u for u in usage_items if u.get('user_id') == user_id), None)
        if not user_record:
            user_record = {'user_id': user_id, 'free_requests_used': 0, 'paid_credits': 0}
            upsert_collection_item('ai_usage', 'user_id', user_id, user_record)

        wallet = get_or_create_wallet(user_id)
        if wallet.get('lastUsageDate') != today_str:
            wallet['dailyUsed'] = 0
            wallet['lastUsageDate'] = today_str

        free_used = int(user_record.get('free_requests_used', 0))
        paid_credits = int(user_record.get('paid_credits', 0))
        daily_used = int(wallet.get('dailyUsed', 0))

        if not is_super and daily_used >= ai_daily_limit:
            return JsonResponse({
                'success': False,
                'requirePayment': False,
                'limitReached': True,
                'reason': 'Daily AI generation limit reached',
                'currentUsage': daily_used,
                'maxAllowed': ai_daily_limit,
                'remainingCredits': paid_credits,
                'message': f'Daily AI usage limit ({daily_used}/{ai_daily_limit}) reached. Try again tomorrow.',
            }, status=429)

        if not is_super and ai_payment_req:
            if free_used < ai_free_limit:
                deducted_mode = 'free'
                user_record['free_requests_used'] = free_used + 1
            elif paid_credits > 0:
                deducted_mode = 'paid'
                user_record['paid_credits'] = paid_credits - 1
            else:
                return JsonResponse({
                    'success': False,
                    'requirePayment': True,
                    'limitReached': True,
                    'reason': 'AI generation quota exhausted',
                    'message': f'You have used all {ai_free_limit} free AI generation(s) and have 0 paid credits remaining.',
                    'currentUsage': free_used,
                    'maxAllowed': ai_free_limit,
                    'remainingCredits': 0,
                    'price': ai_price,
                    'aiCreditsPerPayment': ai_credits_pack,
                    'freeLimit': ai_free_limit,
                    'freeUsed': free_used,
                    'paidCredits': 0,
                })

            upsert_collection_item('ai_usage', 'user_id', user_id, user_record)
            wallet['dailyUsed'] = daily_used + 1
            wallet['usedCredits'] = int(wallet.get('usedCredits', 0)) + 1
            wallet['remainingCredits'] = int(user_record.get('paid_credits', 0)) + max(0, ai_free_limit - int(user_record.get('free_requests_used', 0)))
            upsert_collection_item('ai_wallets', 'userId', user_id, wallet)

    try:
        gen_res = generate_groq_questions(topic, count, difficulty)
        questions = gen_res['questions']
        used_model = gen_res['model']
    except Exception as e:
        # Refund deducted credit atomically on AI service error
        if not is_super and deducted_mode:
            with _usage_lock:
                usage_items = get_collection_items('ai_usage')
                rec = next((u for u in usage_items if u.get('user_id') == user_id), None)
                if rec:
                    if deducted_mode == 'free':
                        rec['free_requests_used'] = max(0, int(rec.get('free_requests_used', 1)) - 1)
                    else:
                        rec['paid_credits'] = int(rec.get('paid_credits', 0)) + 1
                    upsert_collection_item('ai_usage', 'user_id', user_id, rec)
        status_code = 401 if isinstance(e, ValueError) else 502
        return JsonResponse({'success': False, 'detail': str(e), 'message': str(e)}, status=status_code)

    if not is_super:
        insert_collection_item('ai_requests', {
            'user_id': user_id,
            'type': deducted_mode or 'free',
            'model': used_model,
            'status': 'SUCCESS',
            'topic': topic,
            'count': count,
            'created_at': _iso_now(),
        })
        rem_paid = int(user_record.get('paid_credits', 0))
        rem_free = max(0, ai_free_limit - int(user_record.get('free_requests_used', 0)))
        if rem_paid == 0 and rem_free == 0 and ai_payment_req:
            push_notification('AI Credits Exhausted', f'{user_id} has 0 AI credits remaining.', 'warning', user_id)
    else:
        rem_free = 999
        rem_paid = 999

    return JsonResponse({
        'success': True,
        'questions': questions,
        'model': used_model,
        'freeRequestsRemaining': rem_free,
        'paidCreditsRemaining': rem_paid,
    })


# ─── PAYMENTS & ENTITLEMENTS ───────────────────────────────────
@csrf_exempt
@require_http_methods(['POST'])
def py_payment_create_order(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)
    rzp_client, key_id = _get_rzp_client()
    if not rzp_client:
        return JsonResponse({'detail': 'Payment gateway not configured'}, status=500)

    body = _json_body(request)
    topic = body.get('topic')
    count = body.get('count')
    config = get_payment_config()
    ai_price = int(config.get('aiPrice', 10))
    amount_paise = ai_price * 100

    try:
        order = rzp_client.order.create(data={
            'amount': amount_paise,
            'currency': 'INR',
            'receipt': f'receipt_{uuid.uuid4().hex[:10]}',
            'notes': {'user_id': user.get('userId') or user.get('name'), 'topic': topic, 'count': count},
        })
        insert_collection_item('payments', {
            'order_id': order['id'],
            'user_id': user.get('userId') or user.get('name'),
            'amount': order['amount'],
            'currency': order['currency'],
            'status': 'created',
            'topic': topic,
            'count': count,
            'difficulty': body.get('difficulty', 'medium'),
            'created_at': _iso_now(),
        })
        return JsonResponse({
            'success': True,
            'order_id': order['id'],
            'amount': order['amount'],
            'currency': order['currency'],
            'key_id': key_id,
        })
    except Exception as e:
        return JsonResponse({'detail': str(e)}, status=500)


@csrf_exempt
@require_http_methods(['POST'])
def py_payment_verify(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)
    rzp_client, _ = _get_rzp_client()
    if not rzp_client:
        return JsonResponse({'detail': 'Payment gateway not configured'}, status=500)

    body = _json_body(request)
    order_id = body.get('razorpay_order_id')
    payment_id = body.get('razorpay_payment_id')
    signature = body.get('razorpay_signature')
    if not all([order_id, payment_id, signature]):
        return JsonResponse({'detail': 'Missing payment verification details'}, status=400)

    with _payment_lock:
        payments = get_collection_items('payments')
        record = next((p for p in payments if p.get('order_id') == order_id), None)
        if not record:
            return JsonResponse({'detail': 'Order not found'}, status=404)
        if record.get('status') == 'paid':
            return JsonResponse({'detail': 'Payment already processed (Idempotency check)'}, status=400)

        try:
            rzp_client.utility.verify_payment_signature({
                'razorpay_order_id': order_id,
                'razorpay_payment_id': payment_id,
                'razorpay_signature': signature,
            })
        except Exception:
            upsert_collection_item('payments', 'order_id', order_id, {'status': 'failed', 'failed_at': _iso_now()})
            from .billing_service import push_notification
            push_notification('Payment Failed', f'AI payment verification failed for {order_id}', 'error')
            return JsonResponse({'detail': 'Payment signature verification failed'}, status=400)

        upsert_collection_item('payments', 'order_id', order_id, {
            'status': 'paid',
            'payment_id': payment_id,
            'signature': signature,
            'paid_at': _iso_now(),
        })

        cfg = get_payment_config()
        credits_pack = max(1, int(cfg.get('aiCreditsPerPayment', 5)))
        user_id = user.get('userId') or user.get('name') or 'unknown'

        # Allocate AI credits into ai_usage and ai_wallets atomically
        with _usage_lock:
            usage_items = get_collection_items('ai_usage')
            rec = next((u for u in usage_items if u.get('user_id') == user_id), None)
            if not rec:
                rec = {'user_id': user_id, 'free_requests_used': 0, 'paid_credits': 0}
            rec['paid_credits'] = int(rec.get('paid_credits', 0)) + credits_pack
            upsert_collection_item('ai_usage', 'user_id', user_id, rec)

            from .billing_service import adjust_wallet_credits, push_notification
            adjust_wallet_credits(user_id, credits_pack, f'AI Pack Purchase ({order_id})', user_id)
            push_notification('AI Credits Purchased', f'{user_id} purchased +{credits_pack} AI credits ({order_id})', 'success', user_id)

    try:
        gen_res = generate_groq_questions(record.get('topic'), int(record.get('count', 5)), record.get('difficulty', 'medium'))
        questions = gen_res['questions']
        # Deduct 1 credit for this inline generation
        with _usage_lock:
            usage_items = get_collection_items('ai_usage')
            rec = next((u for u in usage_items if u.get('user_id') == user_id), None)
            if rec and int(rec.get('paid_credits', 0)) > 0:
                rec['paid_credits'] = int(rec.get('paid_credits', 0)) - 1
                upsert_collection_item('ai_usage', 'user_id', user_id, rec)
        insert_collection_item('ai_requests', {
            'user_id': user_id,
            'type': 'paid',
            'model': gen_res['model'],
            'order_id': order_id,
            'payment_id': payment_id,
            'status': 'SUCCESS',
            'topic': record.get('topic'),
            'count': record.get('count'),
            'created_at': _iso_now(),
        })
        return JsonResponse({
            'success': True,
            'message': f'Payment verified! +{credits_pack} AI credits added and questions generated.',
            'questions': questions,
            'creditsAdded': credits_pack,
            'paidCreditsRemaining': int(rec.get('paid_credits', 0)) if rec else 0,
        })
    except Exception as e:
        return JsonResponse({
            'success': True,
            'creditsOnly': True,
            'message': f'Payment verified and +{credits_pack} AI credits added to your wallet. Generation note: {e}',
            'order_id': order_id,
            'creditsAdded': credits_pack,
        })


@csrf_exempt
@require_http_methods(['POST'])
def py_payment_mark_failed(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    body = _json_body(request)
    order_id = body.get('order_id')
    if not order_id:
        return JsonResponse({'detail': 'order_id required'}, status=400)
    payments = get_collection_items('payments')
    rec = next((p for p in payments if p.get('order_id') == order_id), None)
    if rec and rec.get('status') != 'paid':
        upsert_collection_item('payments', 'order_id', order_id, {
            'status': 'failed',
            'failureReason': body.get('reason', 'Payment cancelled or failed'),
            'failed_at': _iso_now(),
        })
        from .billing_service import push_notification
        push_notification('Payment Failed', f'Order {order_id} failed/cancelled by {user.get("name", "Admin")}', 'error')
    return JsonResponse({'success': True})


@csrf_exempt
@require_http_methods(['GET', 'POST'])
def py_payment_settings(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)

    if request.method == 'GET':
        cfg = get_payment_config()
        return JsonResponse({'success': True, 'settings': cfg})

    if not user.get('isSuper', False):
        return JsonResponse({'detail': 'Forbidden: Superadmin only'}, status=403)

    data = _json_body(request)
    existing = get_payment_config()
    new_cfg = {
        '_id': 'payment_config',
        'amount': _as_int(data.get('amount'), existing.get('amount', 499)),
        'quizzesPerPayment': _as_int(data.get('quizzesPerPayment'), existing.get('quizzesPerPayment', 2)),
        'validityDays': _as_int(data.get('validityDays'), existing.get('validityDays', 30)),
        'codeValidityDays': _as_int(data.get('codeValidityDays'), existing.get('codeValidityDays', 30)),
        'discountPercent': _as_int(data.get('discountPercent'), existing.get('discountPercent', 0)),
        'enabled': _as_bool(data.get('enabled'), existing.get('enabled', True)),
        'aiPaymentRequired': _as_bool(data.get('aiPaymentRequired'), existing.get('aiPaymentRequired', True)),
        'aiFreeLimit': _as_int(data.get('aiFreeLimit'), existing.get('aiFreeLimit', 0)),
        'aiPrice': _as_int(data.get('aiPrice'), existing.get('aiPrice', 10)),
        'aiCreditsPerPayment': _as_int(data.get('aiCreditsPerPayment'), existing.get('aiCreditsPerPayment', 5)),
        'maxQuestionsPerGen': _as_int(data.get('maxQuestionsPerGen'), existing.get('maxQuestionsPerGen', 20)),
        'aiDailyLimit': _as_int(data.get('aiDailyLimit'), existing.get('aiDailyLimit', 50)),
        'groqModel': str(data.get('groqModel', existing.get('groqModel', 'llama-3.3-70b-versatile'))).strip(),
        'groqApiKey': str(data.get('groqApiKey', existing.get('groqApiKey', ''))).strip(),
        'updatedBy': user.get('name', 'superadmin'),
        'updatedAt': _iso_now(),
    }
    save_payment_config(new_cfg)

    # Mirror into sq_settings so all clients stay synchronized
    try:
        cur_settings = json.loads(get_sync_value('sq_settings', '{}') or '{}')
        cur_settings.update({
            'quiz_price': new_cfg['amount'],
            'quizzes_per_license': new_cfg['quizzesPerPayment'],
            'license_validity_days': new_cfg['validityDays'],
            'quiz_payment_enabled': new_cfg['enabled'],
            'ai_request_price': new_cfg['aiPrice'],
            'ai_payment_required': new_cfg['aiPaymentRequired'],
            'ai_free_limit': new_cfg['aiFreeLimit'],
        })
        if new_cfg['groqApiKey']:
            cur_settings['groq_api_key'] = new_cfg['groqApiKey']
        save_sync_data('sq_settings', json.dumps(cur_settings))
    except Exception:
        pass

    if new_cfg['groqApiKey']:
        os.environ['GROQ_API_KEY'] = new_cfg['groqApiKey']
        env_path = Path(__file__).resolve().parent.parent / '.env'
        if env_path.exists():
            try:
                content = env_path.read_text(encoding='utf-8')
                if 'GROQ_API_KEY=' in content:
                    content = re.sub(r'GROQ_API_KEY=.*', f'GROQ_API_KEY={new_cfg["groqApiKey"]}', content)
                else:
                    content += f'\nGROQ_API_KEY={new_cfg["groqApiKey"]}\n'
                env_path.write_text(content, encoding='utf-8')
            except Exception:
                pass

    try:
        from .billing_service import log_audit, push_notification
        push_notification('Payment Configuration Changed', f"{user.get('name', 'SuperAdmin')} updated billing & AI settings.", 'info')
        log_audit(user.get('name', 'SuperAdmin'), 'Super Admin', 'PAYMENT_CONFIG_UPDATED', 'payment_config', f"price={new_cfg['amount']}, aiPrice={new_cfg['aiPrice']}")
    except Exception:
        pass

    return JsonResponse({'success': True, 'settings': new_cfg})


def _generate_activation_code():
    p1 = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))
    p2 = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))
    return f'QUIZ-{p1}-{p2}'


@csrf_exempt
@require_http_methods(['POST'])
def py_quiz_start_create_order(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)
    rzp_client, key_id = _get_rzp_client()
    if not rzp_client:
        return JsonResponse({'detail': 'Payment gateway not configured'}, status=500)

    body = _json_body(request)
    quiz_id = body.get('quizId', 'LOCAL')
    coupon_code = str(body.get('couponCode') or '').strip().upper()
    cfg = get_payment_config()
    if not cfg.get('enabled', True):
        return JsonResponse({'detail': 'Payments are currently disabled'}, status=400)

    user_id = user.get('userId') or user.get('name')
    base_amount = float(cfg.get('amount', 499))
    discount = float(cfg.get('discountPercent', 0))
    final_amount = max(0.0, round(base_amount * (1 - discount / 100.0), 2))
    if coupon_code:
        from .billing_service import validate_coupon
        ok, msg, discounted = validate_coupon(coupon_code, final_amount, user_id)
        if not ok:
            return JsonResponse({'detail': msg}, status=400)
        final_amount = discounted

    amount_paise = max(100, int(round(final_amount * 100)))

    try:
        order = rzp_client.order.create(data={
            'amount': amount_paise,
            'currency': 'INR',
            'receipt': f'qz_receipt_{uuid.uuid4().hex[:8]}',
            'notes': {'user_id': user_id, 'quiz_id': quiz_id, 'type': 'quiz_start', 'couponCode': coupon_code},
        })
        insert_collection_item('payments', {
            'order_id': order['id'],
            'adminId': user_id,
            'user_id': user_id,
            'amount': order['amount'],
            'currency': order['currency'],
            'couponCode': coupon_code,
            'status': 'created',
            'type': 'quiz_start',
            'created_at': _iso_now(),
        })
        return JsonResponse({
            'success': True,
            'order_id': order['id'],
            'amount': order['amount'],
            'currency': order['currency'],
            'key_id': key_id,
        })
    except Exception as e:
        return JsonResponse({'detail': str(e)}, status=500)


@csrf_exempt
@require_http_methods(['POST'])
def py_quiz_start_verify(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)
    rzp_client, _ = _get_rzp_client()
    if not rzp_client:
        return JsonResponse({'detail': 'Payment gateway not configured'}, status=500)

    body = _json_body(request)
    order_id = body.get('razorpay_order_id')
    payment_id = body.get('razorpay_payment_id')
    signature = body.get('razorpay_signature')
    if not all([order_id, payment_id, signature]):
        return JsonResponse({'detail': 'Missing payment verification details'}, status=400)

    payments = get_collection_items('payments')
    record = next((p for p in payments if p.get('order_id') == order_id and p.get('type') == 'quiz_start'), None)
    if not record:
        return JsonResponse({'detail': 'Order not found'}, status=404)
    if record.get('status') == 'paid':
        return JsonResponse({'detail': 'Payment already processed (Idempotency check)'}, status=400)

    try:
        rzp_client.utility.verify_payment_signature({
            'razorpay_order_id': order_id,
            'razorpay_payment_id': payment_id,
            'razorpay_signature': signature,
        })
    except Exception:
        upsert_collection_item('payments', 'order_id', order_id, {'status': 'failed', 'failed_at': _iso_now()})
        return JsonResponse({'detail': 'Payment signature verification failed'}, status=400)

    upsert_collection_item('payments', 'order_id', order_id, {
        'status': 'paid',
        'payment_id': payment_id,
        'signature': signature,
        'paid_at': _iso_now(),
    })

    applied_coupon = str(record.get('couponCode') or '').strip().upper()
    if applied_coupon:
        coupons = get_collection_items('coupons')
        c = next((x for x in coupons if x.get('code') == applied_coupon), None)
        if c:
            upsert_collection_item('coupons', 'code', applied_coupon, {'usedCount': int(c.get('usedCount', 0)) + 1})

    cfg = get_payment_config()
    code = _generate_activation_code()
    admin_id = user.get('userId') or user.get('name')
    validity_days = int(cfg.get('validityDays', 30))
    quizzes_per = int(cfg.get('quizzesPerPayment', 2))
    now = datetime.now(timezone.utc)

    ent = {
        'adminId': admin_id,
        'paymentId': payment_id,
        'quizLimit': quizzes_per,
        'usedQuizzes': 0,
        'remainingQuizzes': quizzes_per,
        'activationCode': code,
        'validityDays': validity_days,
        'validFrom': now.isoformat(),
        'expiresAt': (now + timedelta(days=validity_days)).isoformat(),
        'status': 'ACTIVE',
    }
    insert_collection_item('entitlements', ent)
    try:
        from .billing_service import push_notification
        push_notification('Quiz License Purchased', f'{admin_id} activated {quizzes_per} quiz credits ({order_id})', 'success', admin_id)
    except Exception:
        pass
    return JsonResponse({
        'success': True,
        'message': 'Payment verified. License activated.',
        'activationCode': code,
        'remainingQuizzes': ent['remainingQuizzes'],
    })


@require_http_methods(['GET'])
def py_entitlements_current(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)
    admin_id = user.get('userId') or user.get('name')
    now = datetime.now(timezone.utc)

    ents = get_collection_items('entitlements')
    active = []
    for e in ents:
        exp = _parse_iso(e.get('expiresAt'))
        if (
            e.get('adminId') == admin_id
            and e.get('status') == 'ACTIVE'
            and int(e.get('remainingQuizzes', 0)) > 0
            and (exp is None or exp > now)
        ):
            active.append(e)
    return JsonResponse({'success': True, 'entitlements': active[:10]})


@require_http_methods(['GET'])
def py_entitlements_all(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)
    if not user.get('isSuper', False):
        return JsonResponse({'detail': 'Forbidden: Superadmin only'}, status=403)
    ents = get_collection_items('entitlements')
    ents.sort(key=lambda x: str(x.get('validFrom', '')), reverse=True)
    return JsonResponse({'success': True, 'entitlements': ents[:100]})


@csrf_exempt
@require_http_methods(['POST'])
def py_quiz_start_activate(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)

    body = _json_body(request)
    code = body.get('code')
    quiz_id = body.get('quizId')
    admin_id = user.get('userId') or user.get('name')
    if not code or not quiz_id:
        return JsonResponse({'detail': 'Missing code or quiz ID'}, status=400)

    now = datetime.now(timezone.utc)
    ents = get_collection_items('entitlements')
    ent = next((
        e for e in ents
        if e.get('adminId') == admin_id
        and e.get('activationCode') == code
        and e.get('status') == 'ACTIVE'
        and int(e.get('remainingQuizzes', 0)) > 0
        and (_parse_iso(e.get('expiresAt')) is None or _parse_iso(e.get('expiresAt')) > now)
    ), None)
    if not ent:
        return JsonResponse({'detail': 'Invalid, expired, or depleted activation code'}, status=400)

    activations = get_collection_items('quiz_activations')
    if any(a.get('adminId') == admin_id and a.get('quizId') == quiz_id for a in activations):
        return JsonResponse({'success': True, 'message': 'Quiz already activated'})

    upsert_collection_item('entitlements', 'activationCode', code, {
        'usedQuizzes': int(ent.get('usedQuizzes', 0)) + 1,
        'remainingQuizzes': max(0, int(ent.get('remainingQuizzes', 0)) - 1),
    })
    insert_collection_item('quiz_activations', {
        'quizId': quiz_id,
        'adminId': admin_id,
        'entitlementId': ent.get('_id', code),
        'paymentId': ent.get('paymentId'),
        'activationCode': code,
        'activatedAt': now.isoformat(),
    })
    return JsonResponse({'success': True, 'message': 'Quiz activated successfully'})


@csrf_exempt
@require_http_methods(['POST'])
def py_record_login(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)
    admin_id = user.get('userId') or user.get('name')
    ua = request.headers.get('User-Agent', 'Unknown')
    ip = request.META.get('REMOTE_ADDR', 'Unknown')
    insert_collection_item('login_history', {
        'adminId': admin_id,
        'loginAt': _iso_now(),
        'ip': ip,
        'device': ua[:120],
    })
    return JsonResponse({'success': True})


@csrf_exempt
@require_http_methods(['POST'])
def py_payment_retry(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)
    rzp_client, key_id = _get_rzp_client()
    if not rzp_client:
        return JsonResponse({'detail': 'Payment gateway not configured'}, status=500)

    body = _json_body(request)
    old_order_id = body.get('order_id')
    payments = get_collection_items('payments')
    old_rec = next((p for p in payments if p.get('order_id') == old_order_id), None)
    if not old_rec:
        return JsonResponse({'detail': 'Original order not found'}, status=404)

    amount_paise = int(old_rec.get('amount') or 49900)
    try:
        order = rzp_client.order.create(data={
            'amount': amount_paise,
            'currency': old_rec.get('currency', 'INR'),
            'receipt': f'retry_{uuid.uuid4().hex[:8]}',
            'notes': {'user_id': old_rec.get('user_id') or user.get('name'), 'retry_of': old_order_id},
        })
        insert_collection_item('payments', {
            'order_id': order['id'],
            'user_id': old_rec.get('user_id') or user.get('userId') or user.get('name'),
            'adminId': old_rec.get('adminId') or old_rec.get('user_id'),
            'amount': order['amount'],
            'currency': order['currency'],
            'status': 'created',
            'type': old_rec.get('type', 'quiz_start'),
            'topic': old_rec.get('topic'),
            'count': old_rec.get('count'),
            'retry_of': old_order_id,
            'created_at': _iso_now(),
        })
        return JsonResponse({
            'success': True,
            'order_id': order['id'],
            'amount': order['amount'],
            'currency': order['currency'],
            'key_id': key_id,
            'type': old_rec.get('type', 'quiz_start'),
        })
    except Exception as e:
        return JsonResponse({'detail': str(e)}, status=500)


@require_http_methods(['GET'])
def py_get_payments(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)

    admin_id = user.get('userId') or user.get('name')
    is_super = bool(user.get('isSuper', False))

    payments = get_collection_items('payments')
    if not is_super:
        payments = [p for p in payments if p.get('user_id') == admin_id or p.get('adminId') == admin_id]
    payments.sort(key=lambda x: str(x.get('created_at', '')), reverse=True)
    payments = payments[:100]

    users_raw = get_sync_value('sq_users', '[]') or '[]'
    user_map = {}
    try:
        for u in json.loads(users_raw):
            if u.get('id'):
                user_map[u['id']] = u
            if u.get('username'):
                user_map[u['username']] = u
            if u.get('name'):
                user_map[u['name']] = u
    except Exception:
        pass

    ents = get_collection_items('entitlements')
    for p in payments:
        uid = p.get('user_id') or p.get('adminId')
        uinfo = user_map.get(uid, {})
        p['adminName'] = uinfo.get('name') or uid or 'Admin'
        p['adminEmail'] = uinfo.get('email') or uinfo.get('username') or '-'
        p['college'] = uinfo.get('college') or '-'
        amt = p.get('amount', 0)
        p['package'] = f"₹{int(amt / 100)} Quiz Plan" if amt else 'Standard Plan'
        p['paymentMethod'] = p.get('paymentMethod') or ('Razorpay Checkout' if p.get('order_id') else 'Online')
        p['planType'] = 'Quiz License' if p.get('type') == 'quiz_start' else 'AI Question Gen'

        if p.get('status') == 'paid' and p.get('payment_id'):
            ent = next((e for e in ents if e.get('paymentId') == p['payment_id']), None)
            if ent:
                p['quizLimit'] = ent.get('quizLimit')
                p['usedQuizzes'] = ent.get('usedQuizzes', 0)
                p['remainingQuizzes'] = ent.get('remainingQuizzes', ent.get('quizLimit', 0))
                p['activationCode'] = ent.get('activationCode', '-')
                p['validityDays'] = ent.get('validityDays', 30)
                p['entitlementStatus'] = ent.get('status', 'ACTIVE')
                p['validFrom'] = str(ent.get('validFrom', ''))
                p['expiresAt'] = str(ent.get('expiresAt', ''))

    return JsonResponse({'success': True, 'payments': payments, 'entitlements': ents if is_super else [e for e in ents if e.get('adminId') == admin_id]})


@require_http_methods(['GET'])
def py_admin_details(request, admin_id):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'No token provided'}, status=401)
    if not user.get('isSuper', False):
        return JsonResponse({'detail': 'Forbidden: Superadmin only'}, status=403)

    logins = [l for l in get_collection_items('login_history') if l.get('adminId') == admin_id]
    logins.sort(key=lambda x: str(x.get('loginAt', '')), reverse=True)

    payments = [p for p in get_collection_items('payments') if p.get('adminId') == admin_id or p.get('user_id') == admin_id]
    payments.sort(key=lambda x: str(x.get('created_at', '')), reverse=True)
    total_paid = sum(p.get('amount', 0) for p in payments if p.get('status') == 'paid')

    ents = [e for e in get_collection_items('entitlements') if e.get('adminId') == admin_id]
    ents.sort(key=lambda x: str(x.get('validFrom', '')), reverse=True)
    active_ent = None
    remaining_quizzes = 0
    for e in ents:
        if e.get('status') == 'ACTIVE' and int(e.get('remainingQuizzes', 0)) > 0:
            remaining_quizzes += int(e.get('remainingQuizzes', 0))
            if not active_ent:
                active_ent = e

    activations = [a for a in get_collection_items('quiz_activations') if a.get('adminId') == admin_id]
    activations.sort(key=lambda x: str(x.get('activatedAt', '')), reverse=True)

    return JsonResponse({
        'success': True,
        'adminId': admin_id,
        'loginCount': len(logins),
        'lastLogin': logins[0].get('loginAt') if logins else None,
        'logins': logins[:50],
        'payments': payments[:50],
        'totalPaid': total_paid,
        'entitlements': ents[:20],
        'activePackage': active_ent is not None,
        'remainingQuizzes': remaining_quizzes,
        'activeEntitlement': active_ent,
        'quizActivations': activations[:50],
        'quizzesonducted': len(activations),
    })
