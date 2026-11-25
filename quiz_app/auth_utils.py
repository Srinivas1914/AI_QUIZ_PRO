import datetime
from typing import Any, Dict, Optional
import jwt
from django.conf import settings


def create_token(claims: Dict[str, Any], expires_hours: int = 24) -> str:
    payload = {
        **claims,
        'exp': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=expires_hours),
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm='HS256')
    if isinstance(token, bytes):
        return token.decode('utf-8')
    return token


def decode_token(token: str) -> Optional[Dict[str, Any]]:
    if not token:
        return None
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=['HS256'])
    except Exception:
        return None


def get_current_user(request) -> Optional[Dict[str, Any]]:
    auth = request.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        token = auth.split(' ', 1)[1].strip()
        return decode_token(token)
    return None
