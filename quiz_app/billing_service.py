import io
import os
import random
import string
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import razorpay
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from .db import (
    get_collection_items,
    get_payment_config,
    insert_collection_item,
    upsert_collection_item,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _now().isoformat()


def _parse_dt(val: Any) -> Optional[datetime]:
    if not val:
        return None
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    try:
        s = str(val).replace('Z', '+00:00')
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


# ─── AUDIT & NOTIFICATIONS ─────────────────────────────────────
def log_audit(actor: str, role: str, action: str, target: str = '', details: str = ''):
    insert_collection_item('billing_audit', {
        'id': f'AUD-{uuid.uuid4().hex[:8].upper()}',
        'actor': actor,
        'role': role,
        'action': action,
        'target': target,
        'details': details,
        'createdAt': _iso_now(),
    })


def push_notification(title: str, message: str, category: str = 'info', user_id: str = 'ALL'):
    insert_collection_item('billing_notifications', {
        'id': f'NTF-{uuid.uuid4().hex[:8].upper()}',
        'title': title,
        'message': message,
        'category': category,  # success | warning | error | info
        'userId': user_id,
        'read': False,
        'createdAt': _iso_now(),
    })


def get_notifications(limit: int = 50) -> List[Dict[str, Any]]:
    items = get_collection_items('billing_notifications')
    items.sort(key=lambda x: str(x.get('createdAt', '')), reverse=True)
    return items[:limit]


def mark_notification_read(ntf_id: Optional[str] = None):
    if ntf_id:
        upsert_collection_item('billing_notifications', 'id', ntf_id, {'read': True})
    else:
        for n in get_collection_items('billing_notifications'):
            if not n.get('read') and n.get('id'):
                upsert_collection_item('billing_notifications', 'id', n['id'], {'read': True})


# ─── ADMIN ROLES & PERMISSIONS ─────────────────────────────────
ROLE_PERMISSIONS = {
    'Super Admin': ['all', 'config', 'revenue', 'transactions', 'refunds', 'support', 'analytics', 'coupons', 'risk', 'wallets'],
    'Finance Admin': ['revenue', 'transactions', 'refunds', 'analytics', 'audit'],
    'Support Admin': ['transactions', 'support', 'wallets', 'notifications'],
    'Analyst': ['revenue', 'analytics'],
}


def get_admin_roles() -> List[Dict[str, Any]]:
    roles = get_collection_items('billing_roles')
    if not roles:
        default_rec = {
            'adminId': 'Super Admin',
            'billingRole': 'Super Admin',
            'permissions': ROLE_PERMISSIONS['Super Admin'],
            'updatedAt': _iso_now(),
        }
        upsert_collection_item('billing_roles', 'adminId', 'Super Admin', default_rec)
        return [default_rec]
    return roles


def set_admin_role(admin_id: str, billing_role: str, actor: str) -> Dict[str, Any]:
    if billing_role not in ROLE_PERMISSIONS:
        raise ValueError(f'Invalid role: {billing_role}')
    rec = {
        'adminId': admin_id,
        'billingRole': billing_role,
        'permissions': ROLE_PERMISSIONS[billing_role],
        'updatedBy': actor,
        'updatedAt': _iso_now(),
    }
    upsert_collection_item('billing_roles', 'adminId', admin_id, rec)
    log_audit(actor, 'Super Admin', 'ROLE_UPDATED', admin_id, f'Assigned {billing_role}')
    return rec


def has_billing_permission(user: Dict[str, Any], perm: str) -> bool:
    if user.get('isSuper'):
        return True
    uid = user.get('userId') or user.get('name') or ''
    roles = get_collection_items('billing_roles')
    rec = next((r for r in roles if r.get('adminId') == uid), None)
    if not rec:
        return False
    perms = rec.get('permissions', [])
    return 'all' in perms or perm in perms


# ─── SUBSCRIPTION LIFECYCLE ────────────────────────────────────
def compute_lifecycle_state(ent: Dict[str, Any]) -> Dict[str, Any]:
    now = _now()
    exp = _parse_dt(ent.get('expiresAt'))
    grace_days = int(ent.get('gracePeriodDays', 3))
    raw_status = (ent.get('status') or 'ACTIVE').upper()
    rem_quizzes = int(ent.get('remainingQuizzes', 0))

    remaining_days = 0
    if exp:
        remaining_days = max(0, int((exp - now).total_seconds() // 86400))

    lifecycle = raw_status
    if raw_status in ('CANCELLED', 'PAUSED', 'RENEWED'):
        lifecycle = raw_status
    elif exp:
        if now > exp + timedelta(days=grace_days):
            lifecycle = 'EXPIRED'
        elif now > exp:
            lifecycle = 'GRACE_PERIOD'
        elif remaining_days <= 7:
            lifecycle = 'RENEWAL_DUE'
        elif rem_quizzes > 0:
            lifecycle = 'ACTIVE'
        else:
            lifecycle = 'EXPIRED'
    elif rem_quizzes <= 0:
        lifecycle = 'EXPIRED'

    reminder = None
    if lifecycle in ('ACTIVE', 'RENEWAL_DUE') and exp:
        if remaining_days <= 1:
            reminder = '1-day renewal reminder'
        elif remaining_days <= 3:
            reminder = '3-day renewal reminder'
        elif remaining_days <= 7:
            reminder = '7-day renewal reminder'

    return {
        **ent,
        'lifecycle': lifecycle,
        'remainingDays': remaining_days,
        'autoRenew': bool(ent.get('autoRenew', False)),
        'gracePeriodDays': grace_days,
        'planTier': ent.get('planTier') or 'Standard',
        'renewalReminder': reminder,
    }


def get_all_subscriptions(admin_id: Optional[str] = None) -> List[Dict[str, Any]]:
    ents = get_collection_items('entitlements')
    if admin_id:
        ents = [e for e in ents if e.get('adminId') == admin_id]
    enriched = [compute_lifecycle_state(e) for e in ents]
    enriched.sort(key=lambda x: str(x.get('validFrom', '')), reverse=True)
    return enriched


def mutate_subscription(code: str, action: str, actor: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    ents = get_collection_items('entitlements')
    ent = next((e for e in ents if e.get('activationCode') == code), None)
    if not ent:
        raise ValueError('Subscription / Activation code not found')

    now = _now()
    history = list(ent.get('renewalHistory', []))
    patch: Dict[str, Any] = {}

    if action == 'pause':
        patch['status'] = 'PAUSED'
        patch['pausedAt'] = now.isoformat()
    elif action == 'resume':
        patch['status'] = 'ACTIVE'
        patch['resumedAt'] = now.isoformat()
    elif action == 'cancel':
        patch['status'] = 'CANCELLED'
        patch['autoRenew'] = False
        patch['cancellationReason'] = payload.get('reason', 'User requested cancellation')
        patch['cancelledAt'] = now.isoformat()
    elif action == 'toggle_autorenew':
        patch['autoRenew'] = not bool(ent.get('autoRenew', False))
    elif action == 'extend':
        extra_days = int(payload.get('days', 7))
        extra_quizzes = int(payload.get('quizzes', 0))
        cur_exp = _parse_dt(ent.get('expiresAt')) or now
        base_dt = cur_exp if cur_exp > now else now
        new_exp = (base_dt + timedelta(days=extra_days)).isoformat()
        patch['expiresAt'] = new_exp
        patch['status'] = 'ACTIVE'
        if extra_quizzes > 0:
            patch['remainingQuizzes'] = int(ent.get('remainingQuizzes', 0)) + extra_quizzes
            patch['quizLimit'] = int(ent.get('quizLimit', 0)) + extra_quizzes
        history.append({'action': 'MANUAL_EXTEND', 'days': extra_days, 'quizzes': extra_quizzes, 'at': now.isoformat(), 'by': actor})
        patch['renewalHistory'] = history
    elif action == 'upgrade_prorate':
        new_tier = payload.get('tier', 'Enterprise')
        new_price = float(payload.get('newPrice', 999))
        old_price = float(payload.get('oldPrice', 499))
        total_days = max(1, int(ent.get('validityDays', 30)))
        cur_exp = _parse_dt(ent.get('expiresAt')) or now
        rem_days = max(0, int((cur_exp - now).total_seconds() // 86400))
        prorated_credit = round((old_price / total_days) * rem_days, 2)
        net_due = max(0.0, round(new_price - prorated_credit, 2))
        patch['planTier'] = new_tier
        patch['quizLimit'] = int(ent.get('quizLimit', 2)) + int(payload.get('extraQuizzes', 3))
        patch['remainingQuizzes'] = int(ent.get('remainingQuizzes', 0)) + int(payload.get('extraQuizzes', 3))
        patch['proratedCredit'] = prorated_credit
        patch['lastProratedCharge'] = net_due
        history.append({'action': f'UPGRADE_{new_tier.upper()}', 'proratedCredit': prorated_credit, 'netCharge': net_due, 'at': now.isoformat()})
        patch['renewalHistory'] = history
    else:
        raise ValueError(f'Unknown subscription action: {action}')

    upsert_collection_item('entitlements', 'activationCode', code, patch)
    log_audit(actor, 'Admin', f'SUBSCRIPTION_{action.upper()}', code, str(patch))
    updated = {**ent, **patch}
    return compute_lifecycle_state(updated)


# ─── AI CREDITS WALLET ─────────────────────────────────────────
def get_or_create_wallet(user_id: str) -> Dict[str, Any]:
    wallets = get_collection_items('ai_wallets')
    w = next((x for x in wallets if x.get('userId') == user_id), None)
    if not w:
        cfg = get_payment_config()
        trial = int(cfg.get('aiFreeLimit', 0))
        w = {
            'userId': user_id,
            'purchasedCredits': 0,
            'trialCredits': trial,
            'usedCredits': 0,
            'remainingCredits': trial,
            'dailyLimit': 50,
            'dailyUsed': 0,
            'lastUsageDate': _now().strftime('%Y-%m-%d'),
            'costPerQuestion': int(cfg.get('aiPrice', 10)),
            'modelUsage': {},
            'updatedAt': _iso_now(),
        }
        upsert_collection_item('ai_wallets', 'userId', user_id, w)
    return w


def adjust_wallet_credits(user_id: str, delta: int, reason: str, actor: str) -> Dict[str, Any]:
    w = get_or_create_wallet(user_id)
    new_rem = max(0, int(w.get('remainingCredits', 0)) + delta)
    new_pur = max(0, int(w.get('purchasedCredits', 0)) + (delta if delta > 0 else 0))
    patch = {
        'remainingCredits': new_rem,
        'purchasedCredits': new_pur,
        'updatedAt': _iso_now(),
    }
    upsert_collection_item('ai_wallets', 'userId', user_id, patch)
    insert_collection_item('ai_requests', {
        'user_id': user_id,
        'type': 'admin_grant' if delta >= 0 else 'admin_deduct',
        'creditsDelta': delta,
        'reason': reason,
        'status': 'SUCCESS',
        'created_at': _iso_now(),
    })
    if new_rem <= 2:
        push_notification('Low AI Credits Alert', f'User {user_id} has only {new_rem} AI credits remaining.', 'warning', user_id)
    log_audit(actor, 'Admin', 'AI_WALLET_ADJUST', user_id, f'delta={delta}, reason={reason}')
    return {**w, **patch}


def get_ai_wallet_overview(user_id: Optional[str] = None) -> Dict[str, Any]:
    wallets = get_collection_items('ai_wallets')
    reqs = get_collection_items('ai_requests')
    if user_id:
        wallets = [get_or_create_wallet(user_id)]
        reqs = [r for r in reqs if r.get('user_id') == user_id]
    reqs.sort(key=lambda x: str(x.get('created_at', '')), reverse=True)
    return {
        'wallets': wallets,
        'history': reqs[:100],
        'totalPurchased': sum(int(w.get('purchasedCredits', 0)) for w in wallets),
        'totalUsed': sum(int(w.get('usedCredits', 0)) for w in wallets),
        'totalRemaining': sum(int(w.get('remainingCredits', 0)) for w in wallets),
    }


# ─── FRAUD & RISK DETECTION ────────────────────────────────────
def analyze_fraud_and_risk() -> Dict[str, Any]:
    payments = get_collection_items('payments')
    existing_flags = get_collection_items('risk_flags')
    flagged_users = {f.get('userId'): f for f in existing_flags}

    by_user: Dict[str, List[Dict[str, Any]]] = {}
    seen_payment_ids: Dict[str, int] = {}
    scored_txns: List[Dict[str, Any]] = []
    alerts: List[Dict[str, Any]] = []

    for p in payments:
        uid = p.get('user_id') or p.get('adminId') or 'unknown'
        by_user.setdefault(uid, []).append(p)
        pid = p.get('payment_id')
        if pid:
            seen_payment_ids[pid] = seen_payment_ids.get(pid, 0) + 1

    for p in payments:
        uid = p.get('user_id') or p.get('adminId') or 'unknown'
        user_txns = by_user.get(uid, [])
        failed_cnt = sum(1 for x in user_txns if x.get('status') == 'failed')
        pending_cnt = sum(1 for x in user_txns if x.get('status') in ('created', 'pending'))
        pid = p.get('payment_id')
        is_dup = bool(pid and seen_payment_ids.get(pid, 0) > 1)

        score = 10
        reasons: List[str] = []
        if p.get('status') == 'failed':
            score += 25
            reasons.append('Failed transaction')
        if failed_cnt >= 2:
            score += 30
            reasons.append(f'{failed_cnt} failed attempts by user')
        if pending_cnt >= 4:
            score += 20
            reasons.append(f'{pending_cnt} repeated unpaid orders')
        if is_dup:
            score += 40
            reasons.append('Duplicate payment ID detected')
        if uid in flagged_users and flagged_users[uid].get('flagged'):
            score += 25
            reasons.append('Manually flagged user')

        score = min(100, score)
        level = 'HIGH' if score >= 70 else ('MEDIUM' if score >= 40 else 'LOW')
        scored_txns.append({
            'order_id': p.get('order_id'),
            'payment_id': pid,
            'user_id': uid,
            'amount': p.get('amount', 0),
            'status': p.get('status'),
            'riskScore': score,
            'riskLevel': level,
            'reasons': reasons,
            'created_at': p.get('created_at'),
        })
        if score >= 50:
            alerts.append({
                'userId': uid,
                'orderId': p.get('order_id'),
                'riskScore': score,
                'riskLevel': level,
                'reason': ', '.join(reasons) or 'Elevated risk pattern',
                'created_at': p.get('created_at'),
            })

    scored_txns.sort(key=lambda x: x['riskScore'], reverse=True)
    return {
        'transactions': scored_txns[:100],
        'alerts': alerts[:50],
        'flaggedUsers': list(flagged_users.values()),
        'highRiskCount': sum(1 for t in scored_txns if t['riskLevel'] == 'HIGH'),
    }


def flag_risk_user(user_id: str, flagged: bool, reason: str, actor: str) -> Dict[str, Any]:
    rec = {
        'userId': user_id,
        'flagged': flagged,
        'reason': reason,
        'flaggedBy': actor,
        'updatedAt': _iso_now(),
    }
    upsert_collection_item('risk_flags', 'userId', user_id, rec)
    if flagged:
        push_notification('Suspicious User Flagged', f'User {user_id} flagged for review: {reason}', 'error', user_id)
    log_audit(actor, 'Admin', 'RISK_FLAG_USER', user_id, f'flagged={flagged}, reason={reason}')
    return rec


# ─── COUPONS & MARKETING ───────────────────────────────────────
def create_coupon(data: Dict[str, Any], actor: str) -> Dict[str, Any]:
    code = str(data.get('code') or '').strip().upper()
    if not code:
        code = 'PROMO-' + ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    coupon = {
        'code': code,
        'discountType': data.get('discountType', 'percent'),  # percent | fixed
        'discountValue': float(data.get('discountValue', 10)),
        'campaign': data.get('campaign', 'General'),
        'maxRedemptions': int(data.get('maxRedemptions', 100)),
        'usedCount': 0,
        'firstTimeOnly': bool(data.get('firstTimeOnly', False)),
        'referralCode': bool(data.get('referralCode', False)),
        'targetUserId': str(data.get('targetUserId') or '').strip(),
        'expiresAt': data.get('expiresAt') or (_now() + timedelta(days=30)).isoformat(),
        'active': True,
        'createdBy': actor,
        'createdAt': _iso_now(),
    }
    upsert_collection_item('coupons', 'code', code, coupon)
    log_audit(actor, 'Super Admin', 'COUPON_CREATED', code, f"{coupon['discountValue']} ({coupon['discountType']})")
    return coupon


def bulk_create_coupons(prefix: str, count: int, discount_type: str, discount_value: float, campaign: str, actor: str) -> List[Dict[str, Any]]:
    created = []
    for _ in range(min(50, max(1, count))):
        suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=5))
        c = create_coupon({
            'code': f'{prefix.upper()}-{suffix}',
            'discountType': discount_type,
            'discountValue': discount_value,
            'campaign': campaign,
            'maxRedemptions': 1,
        }, actor)
        created.append(c)
    return created


def validate_coupon(code: str, amount: float, user_id: str) -> Tuple[bool, str, float]:
    coupons = get_collection_items('coupons')
    c = next((x for x in coupons if x.get('code') == code.strip().upper()), None)
    if not c or not c.get('active', True):
        return False, 'Invalid or inactive coupon code', amount
    exp = _parse_dt(c.get('expiresAt'))
    if exp and _now() > exp:
        return False, 'Coupon has expired', amount
    if int(c.get('usedCount', 0)) >= int(c.get('maxRedemptions', 100)):
        return False, 'Coupon redemption limit reached', amount
    if c.get('targetUserId') and c['targetUserId'] != user_id:
        return False, 'Coupon is restricted to a different user', amount
    if c.get('firstTimeOnly'):
        paid = [p for p in get_collection_items('payments') if (p.get('user_id') == user_id or p.get('adminId') == user_id) and p.get('status') == 'paid']
        if paid:
            return False, 'Coupon valid for first-time purchases only', amount

    val = float(c.get('discountValue', 0))
    if c.get('discountType') == 'fixed':
        final_amt = max(0.0, round(amount - val, 2))
    else:
        final_amt = max(0.0, round(amount * (1.0 - val / 100.0), 2))
    return True, f'Coupon {c["code"]} applied!', final_amt


# ─── GATEWAY HEALTH & WEBHOOKS ─────────────────────────────────
def check_gateway_health() -> Dict[str, Any]:
    key_id = os.getenv('RAZORPAY_KEY_ID', '')
    key_sec = os.getenv('RAZORPAY_KEY_SECRET', '')
    configured = bool(key_id and key_sec and not key_id.startswith('your_'))
    mode = 'TEST' if key_id.startswith('rzp_test_') else ('LIVE' if key_id.startswith('rzp_live_') else 'UNCONFIGURED')

    payments = get_collection_items('payments')
    paid = sum(1 for p in payments if p.get('status') == 'paid')
    total = len(payments)
    success_rate = round((paid / total) * 100, 1) if total else 100.0

    api_ok = False
    latency_ms = 0
    err_msg = ''
    if configured:
        t0 = datetime.now()
        try:
            client = razorpay.Client(auth=(key_id, key_sec))
            client.order.all({'count': 1})
            api_ok = True
        except Exception as e:
            err_msg = str(e)[:180]
        latency_ms = int((datetime.now() - t0).total_seconds() * 1000)

    webhooks = get_collection_items('webhook_logs')
    webhooks.sort(key=lambda x: str(x.get('createdAt', '')), reverse=True)
    return {
        'configured': configured,
        'mode': mode,
        'apiConnected': api_ok,
        'latencyMs': latency_ms,
        'successRate': success_rate,
        'error': err_msg,
        'webhooks': webhooks[:30],
    }


# ─── GST INVOICE PDF GENERATOR ─────────────────────────────────
def generate_invoice_pdf_bytes(order_id: str, billing_address: Optional[Dict[str, Any]] = None) -> Tuple[bytes, str]:
    payments = get_collection_items('payments')
    p = next((x for x in payments if x.get('order_id') == order_id or x.get('payment_id') == order_id), None)
    if not p:
        raise ValueError('Transaction not found')

    total_inr = round(float(p.get('amount', 0)) / 100.0, 2)
    base_inr = round(total_inr / 1.18, 2)
    gst_inr = round(total_inr - base_inr, 2)
    cgst = round(gst_inr / 2.0, 2)
    sgst = round(gst_inr - cgst, 2)

    inv_no = f"INV-{datetime.now().strftime('%Y%m')}-{str(p.get('order_id', '0000'))[-6:].upper()}"
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, h = A4

    # Header banner
    c.setFillColor(colors.HexColor('#0f172a'))
    c.rect(0, h - 95, w, 95, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont('Helvetica-Bold', 20)
    c.drawString(40, h - 48, 'CAMPUS INTELLIQUIZ PRO')
    c.setFont('Helvetica', 10)
    c.drawString(40, h - 66, 'Enterprise SaaS Assessment & Billing Platform | GST TAX INVOICE')
    c.setFont('Helvetica-Bold', 12)
    c.drawRightString(w - 40, h - 48, inv_no)
    c.setFont('Helvetica', 9)
    c.drawRightString(w - 40, h - 66, f"Date: {str(p.get('created_at', _iso_now()))[:10]}")

    # Seller & Customer Billing Address
    y = h - 135
    c.setFillColor(colors.HexColor('#0f172a'))
    c.setFont('Helvetica-Bold', 10)
    c.drawString(40, y, 'BILLED BY:')
    c.drawString(320, y, 'BILLED TO:')
    c.setFont('Helvetica', 9)
    c.drawString(40, y - 16, 'IntelliQuiz Technologies Pvt. Ltd.')
    c.drawString(40, y - 30, 'GSTIN: 37AABCI1234F1Z5')
    c.drawString(40, y - 44, 'Hyderabad, Telangana, India')

    addr = billing_address or {}
    c.drawString(320, y - 16, str(addr.get('company') or p.get('adminName') or p.get('user_id') or 'Customer'))
    c.drawString(320, y - 30, f"GSTIN: {addr.get('gstin') or 'Unregistered'}")
    c.drawString(320, y - 44, f"{addr.get('address') or 'Institutional Campus'}, {addr.get('city') or 'India'}")

    # Line items table
    ty = y - 90
    c.setFillColor(colors.HexColor('#f1f5f9'))
    c.rect(40, ty - 6, w - 80, 24, fill=1, stroke=0)
    c.setFillColor(colors.HexColor('#0f172a'))
    c.setFont('Helvetica-Bold', 9)
    c.drawString(50, ty + 2, 'DESCRIPTION')
    c.drawString(290, ty + 2, 'ORDER / PAYMENT ID')
    c.drawRightString(w - 50, ty + 2, 'AMOUNT (INR)')

    c.setFont('Helvetica', 9)
    desc = 'Quiz License Package' if p.get('type') == 'quiz_start' else f"AI Question Generation ({p.get('topic') or 'MCQ'})"
    c.drawString(50, ty - 26, desc)
    c.drawString(290, ty - 26, str(p.get('payment_id') or p.get('order_id')))
    c.drawRightString(w - 50, ty - 26, f"INR {base_inr:.2f}")

    # Tax Breakdown
    c.line(40, ty - 45, w - 40, ty - 45)
    c.drawRightString(w - 160, ty - 65, 'Taxable Subtotal:')
    c.drawRightString(w - 50, ty - 65, f"INR {base_inr:.2f}")
    c.drawRightString(w - 160, ty - 82, 'CGST (9%):')
    c.drawRightString(w - 50, ty - 82, f"INR {cgst:.2f}")
    c.drawRightString(w - 160, ty - 99, 'SGST (9%):')
    c.drawRightString(w - 50, ty - 99, f"INR {sgst:.2f}")

    c.setFont('Helvetica-Bold', 11)
    c.drawRightString(w - 160, ty - 125, 'TOTAL PAID:')
    c.drawRightString(w - 50, ty - 125, f"INR {total_inr:.2f}")

    c.setFont('Helvetica', 8)
    c.setFillColor(colors.HexColor('#64748b'))
    c.drawString(40, 50, f"Status: {str(p.get('status', 'PAID')).upper()} | Computer-generated GST Invoice.")
    c.showPage()
    c.save()
    return buf.getvalue(), f'{inv_no}.pdf'


# ─── ADVANCED ANALYTICS & SMART INSIGHTS ───────────────────────
def compute_billing_analytics() -> Dict[str, Any]:
    payments = get_collection_items('payments')
    ents = get_all_subscriptions()
    refunds = get_collection_items('refund_requests')

    paid = [p for p in payments if p.get('status') == 'paid']
    failed = [p for p in payments if p.get('status') == 'failed']
    abandoned = [p for p in payments if p.get('status') in ('created', 'pending')]

    total_rev = round(sum(float(p.get('amount', 0)) for p in paid) / 100.0, 2)
    quiz_rev = round(sum(float(p.get('amount', 0)) for p in paid if p.get('type') == 'quiz_start') / 100.0, 2)
    ai_rev = round(total_rev - quiz_rev, 2)
    avg_txn = round(total_rev / len(paid), 2) if paid else 0.0

    active_subs = [e for e in ents if e.get('lifecycle') in ('ACTIVE', 'RENEWAL_DUE')]
    expired_subs = [e for e in ents if e.get('lifecycle') == 'EXPIRED']
    cancelled_subs = [e for e in ents if e.get('lifecycle') == 'CANCELLED']
    renewed_subs = [e for e in ents if len(e.get('renewalHistory', [])) > 0]

    cfg = get_payment_config()
    plan_price = float(cfg.get('amount', 499))
    mrr = round(len(active_subs) * plan_price, 2)
    arr = round(mrr * 12, 2)

    total_subs = max(1, len(ents))
    conv_rate = round((len(paid) / max(1, len(payments))) * 100.0, 1)
    renewal_rate = round((len(renewed_subs) / total_subs) * 100.0, 1)
    cancel_rate = round((len(cancelled_subs) / total_subs) * 100.0, 1)
    churn_rate = round(((len(expired_subs) + len(cancelled_subs)) / total_subs) * 100.0, 1)
    refund_rate = round((len(refunds) / max(1, len(paid))) * 100.0, 1)

    # Monthly trend & Heatmap by day-of-week
    monthly: Dict[str, float] = {}
    heatmap: Dict[str, int] = {}
    cust_totals: Dict[str, float] = {}
    for p in paid:
        dt = _parse_dt(p.get('created_at')) or _now()
        mkey = dt.strftime('%Y-%m')
        amt = float(p.get('amount', 0)) / 100.0
        monthly[mkey] = round(monthly.get(mkey, 0.0) + amt, 2)
        dkey = dt.strftime('%a')
        heatmap[dkey] = heatmap.get(dkey, 0) + 1
        uid = p.get('user_id') or p.get('adminId') or 'Admin'
        cust_totals[uid] = round(cust_totals.get(uid, 0.0) + amt, 2)

    months_sorted = sorted(monthly.items())
    growth_pct = 0.0
    if len(months_sorted) >= 2 and months_sorted[-2][1] > 0:
        growth_pct = round(((months_sorted[-1][1] - months_sorted[-2][1]) / months_sorted[-2][1]) * 100.0, 1)

    top_customers = sorted(
        [{'userId': k, 'totalSpent': v} for k, v in cust_totals.items()],
        key=lambda x: x['totalSpent'],
        reverse=True,
    )[:10]

    inactive_subscribers = [e for e in expired_subs if e.get('adminId') not in {a.get('adminId') for a in active_subs}]
    forecast_next_month = round(mrr * (1.0 + max(0.0, growth_pct) / 100.0), 2)

    insights = []
    if growth_pct > 0:
        insights.append(f'Monthly revenue grew by {growth_pct}% compared to the prior period.')
    if len(abandoned) > 0:
        insights.append(f'{len(abandoned)} checkout session(s) were initiated but not completed (Recovery opportunity).')
    if len(failed) > 0:
        insights.append(f'{len(failed)} failed payment(s) can be retried via the Recovery Queue.')
    if not insights:
        insights.append('Billing pipeline is healthy with zero anomalies detected.')

    return {
        'totalRevenue': total_rev,
        'quizRevenue': quiz_rev,
        'aiRevenue': ai_rev,
        'mrr': mrr,
        'arr': arr,
        'revenueGrowthPct': growth_pct,
        'avgTransactionValue': avg_txn,
        'conversionRate': conv_rate,
        'renewalRate': renewal_rate,
        'cancellationRate': cancel_rate,
        'churnRate': churn_rate,
        'refundRate': refund_rate,
        'forecastNextMonth': forecast_next_month,
        'activeCount': len(active_subs),
        'expiredCount': len(expired_subs),
        'abandonedCount': len(abandoned),
        'failedCount': len(failed),
        'monthlyTrend': [{'month': k, 'revenue': v} for k, v in months_sorted[-6:]],
        'heatmap': heatmap,
        'topCustomers': top_customers,
        'inactiveSubscribers': inactive_subscribers[:20],
        'abandonedPayments': abandoned[:20],
        'insights': insights,
    }
