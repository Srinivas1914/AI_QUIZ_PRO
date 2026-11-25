import json
import os
import re
from typing import Any, Dict, List
import requests
from .db import get_payment_config, get_sync_value


def get_groq_api_keys() -> List[str]:
    keys: List[str] = []
    cfg = get_payment_config()
    if cfg.get('groqApiKey'):
        k = str(cfg['groqApiKey']).strip()
        if k and not k.startswith('your_') and not k.startswith('YOUR_'):
            keys.append(k)

    settings_raw = get_sync_value('sq_settings')
    if settings_raw:
        try:
            s = json.loads(settings_raw)
            if s.get('groq_api_key'):
                k = str(s['groq_api_key']).strip()
                if k and k not in keys and not k.startswith('your_') and not k.startswith('YOUR_'):
                    keys.append(k)
        except Exception:
            pass

    env_key = os.getenv('GROQ_API_KEY', '').strip()
    if env_key and env_key not in keys and not env_key.startswith('your_') and not env_key.startswith('YOUR_'):
        keys.append(env_key)

    return keys


def get_groq_api_key() -> str:
    keys = get_groq_api_keys()
    return keys[0] if keys else ''


def generate_groq_questions(topic: str, count: int, difficulty: str = 'medium') -> List[Dict[str, Any]]:
    api_keys = get_groq_api_keys()
    if not api_keys:
        raise ValueError('Missing GROQ_API_KEY. Please configure a valid gsk_... key in SuperAdmin → Payments → AI Settings or .env')

    prompt = (
        f'Generate {count} multiple choice questions (MCQs) about "{topic}" with {difficulty} difficulty level. '
        'Each question must have 4 options (A, B, C, D), one correct answer index (0-3), and a brief explanation. '
        'Return ONLY a valid JSON object with a "questions" array in this exact format: '
        '{"questions": [{"text":"...","options":["A","B","C","D"],"correct":[0],"explanation":"..."}]}'
    )

    models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']
    last_err = None

    for api_key in api_keys:
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}',
            'User-Agent': 'QuizPlatform/2.0.0 Django',
        }
        for model_name in models:
            payload = {
                'model': model_name,
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0.7,
                'response_format': {'type': 'json_object'},
            }
            try:
                resp = requests.post(
                    'https://api.groq.com/openai/v1/chat/completions',
                    headers=headers,
                    json=payload,
                    timeout=30,
                )
                if resp.status_code == 200:
                    result = resp.json()
                    content = result['choices'][0]['message']['content']
                    parsed = json.loads(content)
                    if isinstance(parsed, dict) and isinstance(parsed.get('questions'), list):
                        questions = parsed['questions']
                    elif isinstance(parsed, list):
                        questions = parsed
                    else:
                        match = re.search(r'\[[\s\S]*\]', content)
                        questions = json.loads(match.group(0)) if match else [parsed]
                    if not isinstance(questions, list):
                        questions = [questions]
                    return questions
                if resp.status_code == 401:
                    last_err = 'Invalid Groq API Key (HTTP 401). Please update a valid gsk_... key in SuperAdmin → Payments → AI Settings.'
                    break  # Try next API key
                last_err = f'HTTP {resp.status_code}: {resp.text[:200]}'
            except Exception as e:
                last_err = str(e)

    raise RuntimeError(f'Failed to generate questions with Groq: {last_err}')
