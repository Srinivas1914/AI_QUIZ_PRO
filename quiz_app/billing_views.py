import csv
import io
import json
import uuid
from datetime import datetime, timezone

from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .auth_utils import get_current_user
from .billing_service import (
    adjust_wallet_credits,
    analyze_fraud_and_risk,
    bulk_create_coupons,
    check_gateway_health,
    compute_billing_analytics,
    create_coupon,
    flag_risk_user,
    get_admin_roles,
    get_ai_wallet_overview,
    get_all_subscriptions,
    get_notifications,
    get_or_create_wallet,
    generate_invoice_pdf_bytes,
    has_billing_permission,
    log_audit,
    mark_notification_read,
    mutate_subscription,
    push_notification,
    set_admin_role,
    validate_coupon,
)
from .db import (
    get_collection_items,
    get_payment_config,
    insert_collection_item,
    upsert_collection_item,
)


def _json_body(request):
    if not request.body:
        return {}
    try:
        return json.loads(request.body.decode('utf-8'))
    except Exception:
        return {}


def _iso_now():
    return datetime.now(timezone.utc).isoformat()


def _uid(user):
    return user.get('userId') or user.get('name') or 'unknown'


# ─── OVERVIEW & ANALYTICS ──────────────────────────────────────
@require_http_methods(['GET'])
def billing_overview(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    if not (user.get('isSuper') or has_billing_permission(user, 'analytics')):
        return JsonResponse({'detail': 'Forbidden'}, status=403)
    analytics = compute_billing_analytics()
    risk = analyze_fraud_and_risk()
    notifications = get_notifications(25)
    return JsonResponse({
        'success': True,
        'analytics': analytics,
        'riskSummary': {'highRiskCount': risk['highRiskCount'], 'alertsCount': len(risk['alerts'])},
        'unreadNotifications': sum(1 for n in notifications if not n.get('read')),
    })


# ─── SUBSCRIPTION LIFECYCLE ────────────────────────────────────
@require_http_methods(['GET'])
def billing_subscriptions(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    is_super = bool(user.get('isSuper'))
    subs = get_all_subscriptions(None if is_super else _uid(user))
    return JsonResponse({'success': True, 'subscriptions': subs})


@csrf_exempt
@require_http_methods(['POST'])
def billing_subscription_action(request, code):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    body = _json_body(request)
    action = body.get('action')
    if not action:
        return JsonResponse({'detail': 'Action required'}, status=400)
    try:
        updated = mutate_subscription(code, action, _uid(user), body)
        return JsonResponse({'success': True, 'subscription': updated})
    except ValueError as e:
        return JsonResponse({'detail': str(e)}, status=400)


# ─── AI CREDITS WALLET ─────────────────────────────────────────
@csrf_exempt
@require_http_methods(['GET', 'POST'])
def billing_ai_wallet(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)

    if request.method == 'GET':
        target_uid = request.GET.get('userId') if user.get('isSuper') else _uid(user)
        return JsonResponse({'success': True, **get_ai_wallet_overview(target_uid)})

    if not (user.get('isSuper') or has_billing_permission(user, 'wallets')):
        return JsonResponse({'detail': 'Forbidden'}, status=403)

    body = _json_body(request)
    target_uid = body.get('userId')
    delta = int(body.get('delta', 0))
    reason = body.get('reason', 'Admin adjustment')
    if not target_uid:
        return JsonResponse({'detail': 'userId required'}, status=400)
    wallet = adjust_wallet_credits(target_uid, delta, reason, _uid(user))
    return JsonResponse({'success': True, 'wallet': wallet})


# ─── FRAUD & RISK MONITORING ───────────────────────────────────
@csrf_exempt
@require_http_methods(['GET', 'POST'])
def billing_risk(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    if not (user.get('isSuper') or has_billing_permission(user, 'risk')):
        return JsonResponse({'detail': 'Forbidden'}, status=403)

    if request.method == 'GET':
        return JsonResponse({'success': True, **analyze_fraud_and_risk()})

    body = _json_body(request)
    rec = flag_risk_user(body.get('userId', ''), bool(body.get('flagged', True)), body.get('reason', 'Suspicious activity'), _uid(user))
    return JsonResponse({'success': True, 'flag': rec})


# ─── NOTIFICATION CENTER ───────────────────────────────────────
@csrf_exempt
@require_http_methods(['GET', 'POST'])
def billing_notifications(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)

    if request.method == 'GET':
        items = get_notifications(50)
        if not user.get('isSuper'):
            uid = _uid(user)
            items = [n for n in items if n.get('userId') in ('ALL', uid)]
        return JsonResponse({'success': True, 'notifications': items, 'unreadCount': sum(1 for n in items if not n.get('read'))})

    body = _json_body(request)
    mark_notification_read(body.get('id'))
    return JsonResponse({'success': True})


# ─── COUPONS & MARKETING ───────────────────────────────────────
@csrf_exempt
@require_http_methods(['GET', 'POST'])
def billing_coupons(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)

    if request.method == 'GET':
        coupons = get_collection_items('coupons')
        coupons.sort(key=lambda x: str(x.get('createdAt', '')), reverse=True)
        return JsonResponse({'success': True, 'coupons': coupons})

    if not (user.get('isSuper') or has_billing_permission(user, 'coupons')):
        return JsonResponse({'detail': 'Forbidden'}, status=403)

    body = _json_body(request)
    c = create_coupon(body, _uid(user))
    return JsonResponse({'success': True, 'coupon': c})


@csrf_exempt
@require_http_methods(['POST'])
def billing_coupons_bulk(request):
    user = get_current_user(request)
    if not user or not user.get('isSuper'):
        return JsonResponse({'detail': 'Forbidden'}, status=403)
    body = _json_body(request)
    created = bulk_create_coupons(
        body.get('prefix', 'QUIZ'),
        int(body.get('count', 5)),
        body.get('discountType', 'percent'),
        float(body.get('discountValue', 15)),
        body.get('campaign', 'Bulk Campaign'),
        _uid(user),
    )
    return JsonResponse({'success': True, 'created': created, 'count': len(created)})


@csrf_exempt
@require_http_methods(['POST'])
def billing_coupons_validate(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    body = _json_body(request)
    code = body.get('code', '')
    cfg = get_payment_config()
    base_amt = float(body.get('amount') or cfg.get('amount', 499))
    ok, msg, final_amt = validate_coupon(code, base_amt, _uid(user))
    return JsonResponse({'success': ok, 'message': msg, 'originalAmount': base_amt, 'finalAmount': final_amt})


# ─── GATEWAY HEALTH ────────────────────────────────────────────
@require_http_methods(['GET'])
def billing_gateway_health(request):
    user = get_current_user(request)
    if not user or not user.get('isSuper'):
        return JsonResponse({'detail': 'Forbidden'}, status=403)
    return JsonResponse({'success': True, **check_gateway_health()})


# ─── ROLES, REFUNDS, TICKETS, ADDRESS, AUDIT ───────────────────
@csrf_exempt
@require_http_methods(['GET', 'POST'])
def billing_roles(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    if request.method == 'GET':
        return JsonResponse({'success': True, 'roles': get_admin_roles()})
    if not user.get('isSuper'):
        return JsonResponse({'detail': 'Forbidden'}, status=403)
    body = _json_body(request)
    try:
        rec = set_admin_role(body.get('adminId', ''), body.get('billingRole', ''), _uid(user))
        return JsonResponse({'success': True, 'role': rec})
    except ValueError as e:
        return JsonResponse({'detail': str(e)}, status=400)


@csrf_exempt
@require_http_methods(['GET', 'POST'])
def billing_refunds(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    if request.method == 'GET':
        items = get_collection_items('refund_requests')
        if not (user.get('isSuper') or has_billing_permission(user, 'refunds')):
            items = [r for r in items if r.get('userId') == _uid(user)]
        items.sort(key=lambda x: str(x.get('createdAt', '')), reverse=True)
        return JsonResponse({'success': True, 'refunds': items})

    body = _json_body(request)
    action = body.get('action', 'request')
    if action == 'request':
        rec = {
            'id': f'REF-{uuid.uuid4().hex[:8].upper()}',
            'orderId': body.get('orderId'),
            'amount': float(body.get('amount', 0)),
            'reason': body.get('reason', 'Customer requested refund'),
            'userId': _uid(user),
            'status': 'PENDING',
            'requiresSuperApproval': float(body.get('amount', 0)) >= 1000,
            'createdAt': _iso_now(),
        }
        insert_collection_item('refund_requests', rec)
        push_notification('Refund Requested', f"{_uid(user)} requested refund for {rec['orderId']}", 'warning')
        return JsonResponse({'success': True, 'refund': rec})

    if not (user.get('isSuper') or has_billing_permission(user, 'refunds')):
        return JsonResponse({'detail': 'Forbidden'}, status=403)
    ref_id = body.get('id')
    new_status = 'APPROVED' if action == 'approve' else 'REJECTED'
    upsert_collection_item('refund_requests', 'id', ref_id, {'status': new_status, 'reviewedBy': _uid(user), 'reviewedAt': _iso_now()})
    log_audit(_uid(user), 'Admin', f'REFUND_{new_status}', str(ref_id))
    return JsonResponse({'success': True, 'status': new_status})


@csrf_exempt
@require_http_methods(['GET', 'POST'])
def billing_tickets(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    if request.method == 'GET':
        items = get_collection_items('support_tickets')
        if not (user.get('isSuper') or has_billing_permission(user, 'support')):
            items = [t for t in items if t.get('userId') == _uid(user)]
        items.sort(key=lambda x: str(x.get('createdAt', '')), reverse=True)
        return JsonResponse({'success': True, 'tickets': items})

    body = _json_body(request)
    if body.get('action') == 'resolve' and (user.get('isSuper') or has_billing_permission(user, 'support')):
        upsert_collection_item('support_tickets', 'id', body.get('id'), {'status': 'RESOLVED', 'reply': body.get('reply', 'Resolved'), 'resolvedAt': _iso_now()})
        return JsonResponse({'success': True})

    tkt = {
        'id': f'TKT-{uuid.uuid4().hex[:6].upper()}',
        'userId': _uid(user),
        'subject': body.get('subject', 'Billing Issue'),
        'message': body.get('message', ''),
        'status': 'OPEN',
        'createdAt': _iso_now(),
    }
    insert_collection_item('support_tickets', tkt)
    push_notification('New Billing Support Ticket', f"{tkt['id']}: {tkt['subject']}", 'info')
    return JsonResponse({'success': True, 'ticket': tkt})


@csrf_exempt
@require_http_methods(['GET', 'POST'])
def billing_address(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    uid = _uid(user)
    if request.method == 'GET':
        addrs = get_collection_items('billing_addresses')
        rec = next((a for a in addrs if a.get('userId') == uid), {})
        return JsonResponse({'success': True, 'address': rec})
    body = _json_body(request)
    rec = {
        'userId': uid,
        'company': body.get('company', ''),
        'gstin': body.get('gstin', ''),
        'address': body.get('address', ''),
        'city': body.get('city', ''),
        'state': body.get('state', ''),
        'pincode': body.get('pincode', ''),
        'updatedAt': _iso_now(),
    }
    upsert_collection_item('billing_addresses', 'userId', uid, rec)
    return JsonResponse({'success': True, 'address': rec})


@require_http_methods(['GET'])
def billing_audit_list(request):
    user = get_current_user(request)
    if not user or not (user.get('isSuper') or has_billing_permission(user, 'audit')):
        return JsonResponse({'detail': 'Forbidden'}, status=403)
    logs = get_collection_items('billing_audit')
    logs.sort(key=lambda x: str(x.get('createdAt', '')), reverse=True)
    return JsonResponse({'success': True, 'audit': logs[:200]})


@require_http_methods(['GET'])
def billing_audit_export(request):
    user = get_current_user(request)
    if not user or not (user.get('isSuper') or has_billing_permission(user, 'audit')):
        return JsonResponse({'detail': 'Forbidden'}, status=403)
    logs = get_collection_items('billing_audit')
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(['ID', 'Actor', 'Role', 'Action', 'Target', 'Details', 'Timestamp'])
    for l in logs:
        w.writerow([l.get('id'), l.get('actor'), l.get('role'), l.get('action'), l.get('target'), l.get('details'), l.get('createdAt')])
    resp = HttpResponse(buf.getvalue(), content_type='text/csv')
    resp['Content-Disposition'] = 'attachment; filename="billing_audit_export.csv"'
    return resp


@require_http_methods(['GET'])
def billing_invoice_pdf(request, order_id):
    user = get_current_user(request)
    if not user:
        from .auth_utils import decode_token
        token_q = request.GET.get('token', '')
        user = decode_token(token_q)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    addrs = get_collection_items('billing_addresses')
    addr = next((a for a in addrs if a.get('userId') == _uid(user)), None)
    try:
        pdf_bytes, filename = generate_invoice_pdf_bytes(order_id, addr)
        resp = HttpResponse(pdf_bytes, content_type='application/pdf')
        resp['Content-Disposition'] = f'attachment; filename="{filename}"'
        return resp
    except ValueError as e:
        return JsonResponse({'detail': str(e)}, status=404)


@require_http_methods(['GET'])
def billing_portal(request):
    user = get_current_user(request)
    if not user:
        return JsonResponse({'detail': 'Unauthorized'}, status=401)
    uid = _uid(user)
    subs = get_all_subscriptions(uid)
    wallet = get_or_create_wallet(uid)
    payments = [p for p in get_collection_items('payments') if p.get('user_id') == uid or p.get('adminId') == uid]
    payments.sort(key=lambda x: str(x.get('created_at', '')), reverse=True)
    addrs = get_collection_items('billing_addresses')
    addr = next((a for a in addrs if a.get('userId') == uid), {})
    tickets = [t for t in get_collection_items('support_tickets') if t.get('userId') == uid]
    cfg = get_payment_config()
    return JsonResponse({
        'success': True,
        'subscriptions': subs,
        'wallet': wallet,
        'payments': payments[:50],
        'address': addr,
        'tickets': tickets[:20],
        'planConfig': cfg,
    })
