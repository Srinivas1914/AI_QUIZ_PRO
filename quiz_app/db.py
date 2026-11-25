import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from pymongo import MongoClient

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = BASE_DIR / 'data.json'

_lock = threading.Lock()
_sync_data: Dict[str, Any] = {}
_initialized = False
_mongo_client: Optional[MongoClient] = None
_mongo_db = None
_mongo_retry_after: float = 0.0


def get_mongo_db():
    global _mongo_client, _mongo_db, _mongo_retry_after
    if _mongo_db is not None:
        return _mongo_db
    if time.time() < _mongo_retry_after:
        return None
    uri = os.getenv('MONGODB_URI', 'mongodb://localhost:27017/quizdb')
    try:
        client = MongoClient(uri, serverSelectionTimeoutMS=2000, socketTimeoutMS=15000)
        client.admin.command('ping')
        _mongo_client = client
        try:
            _mongo_db = client.get_default_database()
        except Exception:
            _mongo_db = client['quizdb']
        print('[DJANGO-DB] Connected to MongoDB')
        return _mongo_db
    except Exception as e:
        _mongo_retry_after = time.time() + 30.0
        print(f'[DJANGO-DB] MongoDB unavailable ({e}); using data.json + memory persistence.')
        return None


def _ensure_loaded():
    global _initialized, _sync_data
    if _initialized:
        return
    with _lock:
        if _initialized:
            return
        db = get_mongo_db()
        loaded = False
        if db is not None:
            try:
                docs = list(db.storages.find({}))
                if docs:
                    for doc in docs:
                        if 'key' in doc and 'val' in doc:
                            _sync_data[doc['key']] = doc['val']
                    loaded = True
            except Exception as e:
                print(f'[DJANGO-DB] Failed loading from MongoDB: {e}')

        if not loaded and DATA_FILE.exists():
            try:
                with open(DATA_FILE, 'r', encoding='utf-8') as f:
                    file_data = json.load(f)
                if isinstance(file_data, dict):
                    for k, v in file_data.items():
                        if k != 'sq_session':
                            _sync_data[k] = v
                if db is not None:
                    for k, v in _sync_data.items():
                        if not k.startswith('_ts_'):
                            db.storages.update_one({'key': k}, {'$set': {'val': v}}, upsert=True)
            except Exception as e:
                print(f'[DJANGO-DB] Failed loading data.json: {e}')
        _initialized = True


def _persist_file():
    try:
        tmp = str(DATA_FILE) + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(_sync_data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, DATA_FILE)
    except Exception as e:
        print(f'[DJANGO-DB] File save error: {e}')


def get_sync_value(key: str, default: Optional[str] = None) -> Optional[str]:
    _ensure_loaded()
    return _sync_data.get(key, default)


def get_all_sync_data() -> Dict[str, Any]:
    _ensure_loaded()
    with _lock:
        return dict(_sync_data)


def save_sync_data(key: str, val: str, ts: Optional[int] = None, ephemeral: bool = False) -> int:
    _ensure_loaded()
    timestamp = ts or int(time.time() * 1000)
    with _lock:
        _sync_data[key] = val
        _sync_data[f'_ts_{key}'] = timestamp
        if not ephemeral:
            _persist_file()

    if not ephemeral:
        db = get_mongo_db()
        if db is not None:
            try:
                db.storages.update_one(
                    {'key': key},
                    {'$set': {'val': val, '_ts': timestamp}},
                    upsert=True,
                )
                _mirror_to_collections(db, key, val)
            except Exception as e:
                print(f'[DJANGO-DB] MongoDB save error for {key}: {e}')
    return timestamp


def _mirror_to_collections(db, key: str, val: str):
    try:
        data = json.loads(val)
        if key == 'sq_users' and isinstance(data, list):
            incoming_ids = [u.get('id') for u in data if isinstance(u, dict) and u.get('id')]
            db.users.delete_many({'id': {'$nin': incoming_ids}})
            for u in data:
                if isinstance(u, dict) and u.get('id'):
                    db.users.update_one({'id': u['id']}, {'$set': u}, upsert=True)
        elif key.startswith('sq_teams_') and isinstance(data, list):
            qid = key.split('_')[2]
            for t in data:
                if isinstance(t, dict) and t.get('id'):
                    doc = {**t, 'quizId': qid}
                    db.teams.update_one({'id': t['id']}, {'$set': doc}, upsert=True)
        elif key.startswith('sq_questions_') and isinstance(data, list):
            qid = key.split('_')[2]
            for q in data:
                if isinstance(q, dict) and q.get('id'):
                    doc = {**q, 'quizId': qid}
                    db.questions.update_one({'id': q['id']}, {'$set': doc}, upsert=True)
    except Exception:
        pass


def delete_user_from_storage(user_id: str) -> List[Dict[str, Any]]:
    _ensure_loaded()
    raw = get_sync_value('sq_users', '[]') or '[]'
    try:
        users = json.loads(raw)
    except Exception:
        users = []
    dedup = {}
    for u in users:
        if isinstance(u, dict) and u.get('id') and u['id'] != user_id:
            dedup[u['id']] = u
    updated = list(dedup.values())
    save_sync_data('sq_users', json.dumps(updated))
    db = get_mongo_db()
    if db is not None:
        try:
            db.users.delete_one({'id': user_id})
        except Exception:
            pass
    return updated


# Local fallback store for structured collections (payments, entitlements, etc.) when MongoDB is offline
_LOCAL_META_KEY = '__django_collections__'


def _get_local_collections() -> Dict[str, Any]:
    _ensure_loaded()
    raw = _sync_data.get(_LOCAL_META_KEY)
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return {}
    if isinstance(raw, dict):
        return raw
    return {}


def _save_local_collections(cols: Dict[str, Any]):
    _sync_data[_LOCAL_META_KEY] = json.dumps(cols)
    _persist_file()


def get_collection_items(name: str) -> List[Dict[str, Any]]:
    db = get_mongo_db()
    if db is not None:
        try:
            items = list(db[name].find({}))
            for it in items:
                if '_id' in it:
                    it['_id'] = str(it['_id'])
            return items
        except Exception:
            pass
    cols = _get_local_collections()
    return list(cols.get(name, []))


def upsert_collection_item(name: str, match_key: str, match_val: Any, doc: Dict[str, Any]):
    clean_doc = {k: v for k, v in doc.items() if k != '_id'}
    db = get_mongo_db()
    if db is not None:
        try:
            db[name].update_one({match_key: match_val}, {'$set': clean_doc}, upsert=True)
        except Exception as e:
            print(f'[DJANGO-DB] MongoDB upsert error ({name}): {e}')
    with _lock:
        cols = _get_local_collections()
        arr = cols.get(name, [])
        idx = next((i for i, x in enumerate(arr) if x.get(match_key) == match_val), None)
        if idx is not None:
            arr[idx] = {**arr[idx], **doc}
        else:
            arr.append({match_key: match_val, **doc})
        cols[name] = arr
        _save_local_collections(cols)


def insert_collection_item(name: str, doc: Dict[str, Any]):
    db = get_mongo_db()
    if db is not None:
        try:
            db[name].insert_one(dict(doc))
            return
        except Exception:
            pass
    with _lock:
        cols = _get_local_collections()
        arr = cols.get(name, [])
        arr.append(dict(doc))
        cols[name] = arr
        _save_local_collections(cols)


def get_payment_config() -> Dict[str, Any]:
    default_cfg = {
        'amount': 499,
        'quizzesPerPayment': 2,
        'validityDays': 30,
        'codeValidityDays': 30,
        'discountPercent': 0,
        'enabled': True,
        'aiPaymentRequired': True,
        'aiFreeLimit': 0,
        'aiPrice': 10,
        'aiCreditsPerPayment': 5,
        'maxQuestionsPerGen': 20,
        'aiDailyLimit': 50,
        'groqModel': 'llama-3.3-70b-versatile',
        'groqApiKey': '',
    }
    db = get_mongo_db()
    if db is not None:
        try:
            doc = db.payment_settings.find_one({'_id': 'payment_config'})
            if doc:
                doc['_id'] = str(doc['_id'])
                return {**default_cfg, **doc}
        except Exception:
            pass
    items = get_collection_items('payment_settings')
    found = next((x for x in items if x.get('_id') == 'payment_config'), None)
    return {**default_cfg, **found} if found else default_cfg


def save_payment_config(cfg: Dict[str, Any]):
    upsert_collection_item('payment_settings', '_id', 'payment_config', cfg)
