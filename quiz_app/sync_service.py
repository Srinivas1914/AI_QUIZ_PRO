import json
import threading
import time
from typing import Any, Dict, List
from .db import get_all_sync_data, get_sync_value, save_sync_data

_cmd_lock = threading.Lock()
_events: List[Dict[str, Any]] = []
_MAX_EVENT_AGE_MS = 20000


def push_event(event_type: str, payload: Dict[str, Any], sender: str = 'System') -> Dict[str, Any]:
    now_ms = int(time.time() * 1000)
    evt = {
        'id': f'{event_type}_{now_ms}_{len(_events)}',
        'event': event_type,
        'payload': {**payload, 'sender': sender},
        'ts': now_ms,
    }
    with _cmd_lock:
        _events.append(evt)
        cutoff = now_ms - _MAX_EVENT_AGE_MS
        _events[:] = [e for e in _events if e['ts'] >= cutoff]
    return evt


def get_events_since(since_ts: int) -> List[Dict[str, Any]]:
    now_ms = int(time.time() * 1000)
    cutoff = now_ms - _MAX_EVENT_AGE_MS
    with _cmd_lock:
        _events[:] = [e for e in _events if e['ts'] >= cutoff]
        return [e for e in _events if e['ts'] > since_ts]


def filter_users_for_user(users_raw: str, user: Dict[str, Any]) -> str:
    if not user:
        return '[]'
    if user.get('isSuper'):
        return users_raw
    if user.get('role') != 'admin':
        return '[]'
    try:
        users = json.loads(users_raw or '[]')
    except Exception:
        return '[]'
    admin_inst = (user.get('college') or '').strip().lower()
    admin_qid = user.get('quizId')
    filtered = []
    for u in users:
        if not isinstance(u, dict):
            continue
        u_inst = (u.get('college') or '').strip().lower()
        if (u_inst and admin_inst and u_inst == admin_inst) or (admin_qid and u.get('currentQuizId') == admin_qid):
            filtered.append(u)
    return json.dumps(filtered)


def handle_sync_push(key: str, val: Any, user: Dict[str, Any], ts: int) -> Dict[str, Any]:
    val_str = val if isinstance(val, str) else json.dumps(val)

    if key in ('sq_questions', 'sq_rounds', 'sq_settings') and user.get('role') != 'admin':
        raise PermissionError('Unauthorized config sync attempt')

    if key == 'sq_users':
        incoming_users = json.loads(val_str or '[]')
        dedup_in = {u['id']: u for u in incoming_users if isinstance(u, dict) and u.get('id')}
        incoming_list = list(dedup_in.values())

        if not user.get('isSuper'):
            current_all = json.loads(get_sync_value('sq_users', '[]') or '[]')
            admin_inst = (user.get('college') or '').strip().lower()
            admin_qid = user.get('quizId')
            other_users = []
            for u in current_all:
                if not isinstance(u, dict) or not u.get('id'):
                    continue
                u_inst = (u.get('college') or '').strip().lower()
                match_college = bool(u_inst and admin_inst and u_inst == admin_inst)
                match_quiz = bool(admin_qid and u.get('currentQuizId') == admin_qid)
                if not (match_college or match_quiz):
                    other_users.append(u)

            merged = {u['id']: u for u in other_users}
            for u in incoming_list:
                merged[u['id']] = u
            final_users = list(merged.values())
        else:
            final_users = incoming_list

        val_str = json.dumps(final_users)

    is_ephemeral = (
        key.startswith('sq_cam_')
        or key.startswith('sq_cam_status')
        or key.startswith('sq_activity')
    )
    saved_ts = save_sync_data(key, val_str, ts=ts, ephemeral=is_ephemeral)
    return {'key': key, 'ts': saved_ts}


def get_sync_state_for_user(user: Dict[str, Any], since_ts: int = 0) -> Dict[str, Any]:
    all_data = get_all_sync_data()
    updates: Dict[str, Any] = {}
    max_ts = since_ts

    for key, val in all_data.items():
        if key.startswith('_ts_') or key in ('sq_session', '__django_collections__'):
            continue
        key_ts = int(all_data.get(f'_ts_{key}', 1) or 1)
        if since_ts > 0 and key_ts <= since_ts:
            continue

        if key == 'sq_users':
            if not user or (not user.get('isSuper') and user.get('role') != 'admin'):
                continue
            val = filter_users_for_user(val, user)

        updates[key] = {'val': val, '_ts': key_ts}
        if key_ts > max_ts:
            max_ts = key_ts

    events = get_events_since(since_ts)
    for e in events:
        if e['ts'] > max_ts:
            max_ts = e['ts']

    return {
        'success': True,
        'updates': updates,
        'events': events,
        'serverTs': max_ts or int(time.time() * 1000),
    }
