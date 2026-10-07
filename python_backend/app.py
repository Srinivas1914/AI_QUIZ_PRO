import os
import json
import uuid
from typing import Dict, Any, List, Optional
from datetime import datetime

from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import razorpay
from jose import JWTError, jwt
import requests
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

PORT = int(os.getenv("PORT", 5000))
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/quizdb")
JWT_SECRET = os.getenv("JWT_SECRET", "fallback-secret")
RAZORPAY_KEY_ID = os.getenv("RAZORPAY_KEY_ID")
RAZORPAY_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

FREE_LIMIT = 3
GENERATION_COST_INR = 10 * 100 # ₹10 in paise

app = FastAPI(title="AI Quiz Razorpay Integration API")

# Setup CORS (Allowing frontend to connect)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In production, set to specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize MongoDB Client
client = AsyncIOMotorClient(MONGODB_URI)
db = client.get_default_database() # Uses 'quizdb' from URI

# Initialize Razorpay Client
if RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET and not RAZORPAY_KEY_ID.startswith("your_"):
    rzp_client = razorpay.Client(auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET))
else:
    rzp_client = None
    print("[WARNING] Razorpay credentials not configured or invalid.")

async def get_current_user(request: Request):
    auth_header = request.headers.get('Authorization')
    if not auth_header or not auth_header.startswith('Bearer '):
        raise HTTPException(status_code=401, detail="No token provided")
    
    token = auth_header.split(' ')[1]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
        return payload
    except JWTError as e:
        raise HTTPException(status_code=401, detail="Invalid token")

def get_groq_api_key():
    from dotenv import dotenv_values
    
    # Try reading directly from file to pick up changes without restart
    # Important: get the absolute path to python_backend/.env
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    env_config = dotenv_values(env_path)
    key = env_config.get("GROQ_API_KEY")
    
    # Fallback to os environ
    if not key:
        key = os.getenv("GROQ_API_KEY")
        
    if key and not key.startswith('your_'):
        return key
    
    # Fallback to DB
    try:
        import asyncio
        loop = asyncio.get_event_loop()
        if loop.is_running():
            import nest_asyncio
            nest_asyncio.apply()
        config = loop.run_until_complete(db.payment_settings.find_one({"_id": "payment_config"}))
        if config and config.get("groqApiKey"):
            return config["groqApiKey"]
    except Exception as e:
        pass
    return None

def generate_groq_questions(topic: str, count: int, difficulty: str) -> List[Dict]:
    api_key = get_groq_api_key()
    if not api_key:
        raise HTTPException(status_code=401, detail="Missing GROQ_API_KEY. Please configure it in SuperAdmin Settings or .env")

    prompt = f"Generate {count} multiple choice questions (MCQs) about {topic} with {difficulty} difficulty level. Each question must have 4 options (A, B, C, D) and only one correct answer index (0-3). Return ONLY a JSON array of objects. Do not include markdown code block backticks. Format: [{{\"text\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"correct\":[0],\"explanation\":\"...\"}}]"
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    data = {
        "model": "openai/gpt-oss-120b",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7,
        "response_format": {"type": "json_object"}
    }
    
    try:
        res = requests.post("https://api.groq.com/openai/v1/chat/completions", headers=headers, json=data, timeout=30)
        res.raise_for_status()
        result = res.json()
        
        content = result['choices'][0]['message']['content']
        
        # Simple extraction logic similar to Node.js backend
        import re
        match = re.search(r'\[[\s\S]*\]', content)
        if match:
            questions = json.loads(match.group(0))
        else:
            parsed = json.loads(content)
            questions = parsed.get('questions', parsed if isinstance(parsed, list) else [parsed])
            
        if not isinstance(questions, list):
            questions = [questions]
            
        return questions
        
    except requests.exceptions.RequestException as e:
        print(f"[Groq API Error] {e}")
        if hasattr(e, 'response') and e.response is not None:
             print(f"Response: {e.response.text}")
        raise HTTPException(status_code=502, detail="Failed to connect to AI service")
    except json.JSONDecodeError as e:
        print(f"[JSON Decode Error] {e} on content: {content[:200]}")
        raise HTTPException(status_code=500, detail="Failed to parse AI response")
    except Exception as e:
         print(f"[Unexpected Error] {e}")
         raise HTTPException(status_code=500, detail="Server error processing AI generation")

@app.post("/py-api/ai/generate")
async def ai_generate(request: Request, user: dict = Depends(get_current_user)):
    data = await request.json()
    topic = data.get('topic')
    count = data.get('count')
    difficulty = data.get('difficulty', 'medium')
    
    if not topic or not count:
        raise HTTPException(status_code=400, detail="Topic and count required")
        
    user_id = user.get('userId') or user.get('name') or 'unknown'
    is_super = user.get('isSuper', False)
    
    # Check payment settings
    config = await db.payment_settings.find_one({"_id": "payment_config"}) or {}
    ai_payment_req = config.get("aiPaymentRequired", True)
    ai_free_limit = int(config.get("aiFreeLimit", 0))
    ai_price = int(config.get("aiPrice", 10))
    
    # Check usage in MongoDB
    user_record = await db.ai_usage.find_one({"user_id": user_id})
    if not user_record:
        user_record = {"user_id": user_id, "free_requests_used": 0}
        await db.ai_usage.insert_one(user_record)
        
    free_used = user_record.get('free_requests_used', 0)
    
    if not is_super and ai_payment_req and free_used >= ai_free_limit:
        return {
            "requirePayment": True,
            "limitReached": True,
            "message": "AI Question Generation requires payment.",
            "price": ai_price
        }
        
    # Generate Questions
    questions = generate_groq_questions(topic, count, difficulty)
    
    # Increment usage count and log request if not superadmin
    if not is_super:
        await db.ai_usage.update_one(
            {"user_id": user_id},
            {"$inc": {"free_requests_used": 1}}
        )
        await db.ai_requests.insert_one({
            "user_id": user_id,
            "type": "free" if free_used < ai_free_limit else "paid",
            "status": "SUCCESS",
            "topic": topic,
            "count": count,
            "created_at": datetime.utcnow()
        })
        
    return {"success": True, "questions": questions, "freeRequestsRemaining": max(0, ai_free_limit - (free_used + 1))}

@app.post("/py-api/payment/create_order")
async def create_payment_order(request: Request, user: dict = Depends(get_current_user)):
    if not rzp_client:
        raise HTTPException(status_code=500, detail="Payment gateway not configured")
        
    try:
        data = await request.json()
        topic = data.get('topic')
        count = data.get('count')
        
        # Fetch dynamic price from settings
        storage_doc = await db.storages.find_one({"key": "sq_settings"})
        ai_price = 10 # default
        if storage_doc and 'val' in storage_doc:
            try:
                settings = json.loads(storage_doc['val'])
                ai_price = int(settings.get('ai_request_price', 10))
            except Exception as e:
                print(f"[Settings Parsing Error] {e}")
                
        amount_paise = ai_price * 100
        
        # Create Razorpay order
        order_data = {
            "amount": amount_paise,
            "currency": "INR",
            "receipt": f"receipt_{uuid.uuid4().hex[:10]}",
            "notes": {
                "user_id": user.get('userId') or user.get('name'),
                "topic": topic,
                "count": count
            }
        }
        
        order = rzp_client.order.create(data=order_data)
        
        # Save order to DB as pending
        await db.payments.insert_one({
            "order_id": order['id'],
            "user_id": user.get('userId') or user.get('name'),
            "amount": order['amount'],
            "currency": order['currency'],
            "status": "created",
            "topic": topic,
            "count": count,
            "difficulty": data.get('difficulty', 'medium'),
            "created_at": datetime.utcnow()
        })
        
        return {
            "success": True, 
            "order_id": order['id'], 
            "amount": order['amount'], 
            "currency": order['currency'],
            "key_id": RAZORPAY_KEY_ID
        }
    except Exception as e:
        print(f"[Payment Create Error] {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/py-api/payment/verify")
async def verify_payment(request: Request, user: dict = Depends(get_current_user)):
    if not rzp_client:
        raise HTTPException(status_code=500, detail="Payment gateway not configured")
        
    data = await request.json()
    razorpay_order_id = data.get('razorpay_order_id')
    razorpay_payment_id = data.get('razorpay_payment_id')
    razorpay_signature = data.get('razorpay_signature')
    
    if not all([razorpay_order_id, razorpay_payment_id, razorpay_signature]):
        raise HTTPException(status_code=400, detail="Missing payment verification details")
        
    # Idempotency check: verify this order hasn't already been processed successfully
    payment_record = await db.payments.find_one({"order_id": razorpay_order_id})
    if not payment_record:
        raise HTTPException(status_code=404, detail="Order not found")
        
    if payment_record.get('status') == 'paid':
        raise HTTPException(status_code=400, detail="Payment already processed (Idempotency check)")
        
    # Verify Signature
    try:
        rzp_client.utility.verify_payment_signature({
            'razorpay_order_id': razorpay_order_id,
            'razorpay_payment_id': razorpay_payment_id,
            'razorpay_signature': razorpay_signature
        })
    except razorpay.errors.SignatureVerificationError:
        await db.payments.update_one(
            {"order_id": razorpay_order_id},
            {"$set": {"status": "failed", "failed_at": datetime.utcnow()}}
        )
        raise HTTPException(status_code=400, detail="Payment signature verification failed")

    # Payment is successful and verified
    # Mark as paid in DB
    await db.payments.update_one(
         {"order_id": razorpay_order_id},
         {"$set": {
             "status": "paid", 
             "payment_id": razorpay_payment_id,
             "signature": razorpay_signature,
             "paid_at": datetime.utcnow()
         }}
    )
    
    # Generate Questions since payment succeeded
    topic = payment_record.get('topic')
    count = payment_record.get('count')
    difficulty = payment_record.get('difficulty')
    user_id = user.get('userId') or user.get('name') or 'unknown'
    
    try:
        questions = generate_groq_questions(topic, count, difficulty)
        
        # Log the paid request
        await db.ai_requests.insert_one({
            "user_id": user_id,
            "type": "paid",
            "order_id": razorpay_order_id,
            "payment_id": razorpay_payment_id,
            "status": "SUCCESS",
            "topic": topic,
            "count": count,
            "created_at": datetime.now()
        })
        
        return {"success": True, "message": "Payment successful and request sent successfully", "questions": questions}
    except Exception as e:
        # Edge case: Payment succeeded but Groq generation failed
        print(f"[Groq After Payment Error] {e}")
        # In a real app, you might flag this for refund or manual retry
        return {"success": False, "message": "Payment verified but question generation failed. Please contact support.", "order_id": razorpay_order_id}

@app.get("/py-api/payment-settings")
async def get_payment_settings(request: Request, user: dict = Depends(get_current_user)):
    config = await db.payment_settings.find_one({"_id": "payment_config"})
    if not config:
        config = {
            "amount": 499,
            "quizzesPerPayment": 2,
            "validityDays": 30,
            "codeValidityDays": 30,
            "discountPercent": 0,
            "enabled": True,
            "aiPaymentRequired": True,
            "aiFreeLimit": 0,
            "aiPrice": 10,
            "groqApiKey": ""
        }
    else:
        if "_id" in config:
            config["_id"] = str(config["_id"])
        if "updatedAt" in config and hasattr(config["updatedAt"], 'isoformat'):
            config["updatedAt"] = config["updatedAt"].isoformat()
    return {"success": True, "settings": config}

@app.post("/py-api/payment-settings")
async def update_payment_settings(request: Request, user: dict = Depends(get_current_user)):
    if not user.get('isSuper', False):
        raise HTTPException(status_code=403, detail="Forbidden: Superadmin only")
    
    data = await request.json()
    new_config = {
        "amount": int(data.get("amount", 499)),
        "quizzesPerPayment": int(data.get("quizzesPerPayment", 2)),
        "validityDays": int(data.get("validityDays", 30)),
        "codeValidityDays": int(data.get("codeValidityDays", 30)),
        "discountPercent": int(data.get("discountPercent", 0)),
        "enabled": bool(data.get("enabled", True)),
        "aiPaymentRequired": bool(data.get("aiPaymentRequired", True)),
        "aiFreeLimit": int(data.get("aiFreeLimit", 0)),
        "aiPrice": int(data.get("aiPrice", 10)),
        "groqApiKey": str(data.get("groqApiKey", "")).strip(),
        "updatedBy": user.get('name', 'superadmin'),
        "updatedAt": datetime.utcnow().isoformat()
    }
    
    await db.payment_settings.update_one(
        {"_id": "payment_config"},
        {"$set": new_config},
        upsert=True
    )

    # If Groq API Key was provided, also save to python_backend/.env and root .env
    if new_config["groqApiKey"]:
        try:
            import re
            env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
            if os.path.exists(env_path):
                with open(env_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                if "GROQ_API_KEY=" in content:
                    content = re.sub(r'GROQ_API_KEY=.*', f'GROQ_API_KEY={new_config["groqApiKey"]}', content)
                else:
                    content += f'\nGROQ_API_KEY={new_config["groqApiKey"]}\n'
                with open(env_path, 'w', encoding='utf-8') as f:
                    f.write(content)
        except Exception as e:
            print(f"[ENV Update Error] {e}")

    return {"success": True, "settings": new_config}

@app.post("/py-api/quiz-start/create_order")
async def create_quiz_start_order(request: Request, user: dict = Depends(get_current_user)):
    if not rzp_client:
        raise HTTPException(status_code=500, detail="Payment gateway not configured")
        
    try:
        data = await request.json()
        quiz_id = data.get('quizId', 'LOCAL')
        
        config = await db.payment_settings.find_one({"_id": "payment_config"})
        if not config:
            config = {"amount": 499, "discountPercent": 0, "enabled": True}
            
        if not config.get('enabled', True):
            raise HTTPException(status_code=400, detail="Payments are currently disabled")
            
        base_amount = config.get('amount', 499)
        discount = config.get('discountPercent', 0)
        final_amount = base_amount * (1 - discount/100)
        amount_paise = int(final_amount * 100)
        
        # Create Razorpay order
        order_data = {
            "amount": amount_paise,
            "currency": "INR",
            "receipt": f"qz_receipt_{uuid.uuid4().hex[:8]}",
            "notes": {
                "user_id": user.get('userId') or user.get('name'),
                "quiz_id": quiz_id,
                "type": "quiz_start"
            }
        }
        
        order = rzp_client.order.create(data=order_data)
        
        # Save order to DB as pending
        await db.payments.insert_one({
            "order_id": order['id'],
            "adminId": user.get('userId') or user.get('name'),
            "amount": order['amount'],
            "currency": order['currency'],
            "status": "created",
            "type": "quiz_start",
            "created_at": datetime.utcnow()
        })
        
        return {
            "success": True, 
            "order_id": order['id'], 
            "amount": order['amount'], 
            "currency": order['currency'],
            "key_id": RAZORPAY_KEY_ID
        }
    except Exception as e:
        print(f"[Quiz Start Payment Create Error] {e}")
        raise HTTPException(status_code=500, detail=str(e))

import random
import string
def generate_activation_code():
    return f"QUIZ-{''.join(random.choices(string.ascii_uppercase + string.digits, k=4))}-{''.join(random.choices(string.ascii_uppercase + string.digits, k=4))}"

from datetime import timedelta

@app.post("/py-api/quiz-start/verify")
async def verify_quiz_start_payment(request: Request, user: dict = Depends(get_current_user)):
    if not rzp_client:
        raise HTTPException(status_code=500, detail="Payment gateway not configured")
        
    data = await request.json()
    razorpay_order_id = data.get('razorpay_order_id')
    razorpay_payment_id = data.get('razorpay_payment_id')
    razorpay_signature = data.get('razorpay_signature')
    
    if not all([razorpay_order_id, razorpay_payment_id, razorpay_signature]):
        raise HTTPException(status_code=400, detail="Missing payment verification details")
        
    payment_record = await db.payments.find_one({"order_id": razorpay_order_id, "type": "quiz_start"})
    if not payment_record:
        raise HTTPException(status_code=404, detail="Order not found")
        
    if payment_record.get('status') == 'paid':
        raise HTTPException(status_code=400, detail="Payment already processed (Idempotency check)")
        
    try:
        rzp_client.utility.verify_payment_signature({
            'razorpay_order_id': razorpay_order_id,
            'razorpay_payment_id': razorpay_payment_id,
            'razorpay_signature': razorpay_signature
        })
    except razorpay.errors.SignatureVerificationError:
        await db.payments.update_one(
            {"order_id": razorpay_order_id},
            {"$set": {"status": "failed", "failed_at": datetime.utcnow()}}
        )
        raise HTTPException(status_code=400, detail="Payment signature verification failed")

    # Payment verified
    await db.payments.update_one(
         {"order_id": razorpay_order_id},
         {"$set": {
             "status": "paid", 
             "payment_id": razorpay_payment_id,
             "signature": razorpay_signature,
             "paid_at": datetime.utcnow()
         }}
    )
    
    config = await db.payment_settings.find_one({"_id": "payment_config"})
    if not config:
        config = {"quizzesPerPayment": 2, "validityDays": 30}
        
    # Generate Entitlement
    activation_code = generate_activation_code()
    admin_id = user.get('userId') or user.get('name')
    validity_days = config.get('validityDays', 30)
    
    entitlement = {
        "adminId": admin_id,
        "paymentId": razorpay_payment_id,
        "quizLimit": config.get('quizzesPerPayment', 2),
        "usedQuizzes": 0,
        "remainingQuizzes": config.get('quizzesPerPayment', 2),
        "activationCode": activation_code,
        "validityDays": validity_days,
        "validFrom": datetime.utcnow(),
        "expiresAt": datetime.utcnow() + timedelta(days=validity_days),
        "status": "ACTIVE"
    }
    
    await db.entitlements.insert_one(entitlement)
    
    return {
        "success": True, 
        "message": "Payment verified. License activated.", 
        "activationCode": activation_code,
        "remainingQuizzes": entitlement["remainingQuizzes"]
    }

@app.get("/py-api/entitlements/current")
async def get_current_entitlements(request: Request, user: dict = Depends(get_current_user)):
    admin_id = user.get('userId') or user.get('name')
    now = datetime.utcnow()
    
    # Find active entitlements with remaining quota and not expired
    entitlements = await db.entitlements.find({
        "adminId": admin_id,
        "status": "ACTIVE",
        "remainingQuizzes": {"$gt": 0},
        "expiresAt": {"$gt": now}
    }).to_list(length=10)
    
    # Convert ObjectId
    for e in entitlements:
        e["_id"] = str(e["_id"])
        e["expiresAt"] = e["expiresAt"].isoformat()
        e["validFrom"] = e["validFrom"].isoformat()
        
    return {"success": True, "entitlements": entitlements}

@app.get("/py-api/entitlements/all")
async def get_all_entitlements(request: Request, user: dict = Depends(get_current_user)):
    if not user.get('isSuper', False):
        raise HTTPException(status_code=403, detail="Forbidden: Superadmin only")
        
    entitlements = await db.entitlements.find({}).sort("validFrom", -1).to_list(length=100)
    for e in entitlements:
        e["_id"] = str(e["_id"])
        e["expiresAt"] = e["expiresAt"].isoformat()
        e["validFrom"] = e["validFrom"].isoformat()
        
    return {"success": True, "entitlements": entitlements}

@app.post("/py-api/quiz-start/activate")
async def activate_quiz_start(request: Request, user: dict = Depends(get_current_user)):
    data = await request.json()
    code = data.get('code')
    quiz_id = data.get('quizId')
    admin_id = user.get('userId') or user.get('name')
    
    if not code or not quiz_id:
        raise HTTPException(status_code=400, detail="Missing code or quiz ID")
        
    now = datetime.utcnow()
    
    # Find matching entitlement
    entitlement = await db.entitlements.find_one({
        "adminId": admin_id,
        "activationCode": code,
        "status": "ACTIVE",
        "remainingQuizzes": {"$gt": 0},
        "expiresAt": {"$gt": now}
    })
    
    if not entitlement:
        raise HTTPException(status_code=400, detail="Invalid, expired, or depleted activation code")
        
    # Check if this quiz was already activated with THIS code to prevent double charging
    already_activated = await db.quiz_activations.find_one({
        "adminId": admin_id,
        "quizId": quiz_id
    })
    
    if already_activated:
        return {"success": True, "message": "Quiz already activated"}
        
    # Consume 1 quota atomically
    result = await db.entitlements.update_one(
        {"_id": entitlement["_id"], "remainingQuizzes": {"$gt": 0}},
        {"$inc": {"usedQuizzes": 1, "remainingQuizzes": -1}}
    )
    
    if result.modified_count == 0:
        raise HTTPException(status_code=400, detail="Failed to consume quota (maybe depleted)")
        
    # Record activation
    await db.quiz_activations.insert_one({
        "quizId": quiz_id,
        "adminId": admin_id,
        "entitlementId": entitlement["_id"],
        "paymentId": entitlement.get("paymentId"),
        "activationCode": code,
        "activatedAt": datetime.utcnow()
    })
    
    return {"success": True, "message": "Quiz activated successfully"}

# ─── LOGIN HISTORY ──────────────────────────────────────────────
@app.post("/py-api/record-login")
async def record_login(request: Request, user: dict = Depends(get_current_user)):
    admin_id = user.get('userId') or user.get('name')
    ua = request.headers.get('User-Agent', 'Unknown')
    ip = request.client.host if request.client else 'Unknown'
    
    await db.login_history.insert_one({
        "adminId": admin_id,
        "loginAt": datetime.utcnow(),
        "ip": ip,
        "device": ua[:120]
    })
    return {"success": True}

# ─── PAYMENTS LIST (for both superadmin and admin) ──────────────
@app.get("/py-api/payments")
async def get_payments(request: Request, user: dict = Depends(get_current_user)):
    admin_id = user.get('userId') or user.get('name')
    is_super = user.get('isSuper', False)
    
    query = {} if is_super else {"user_id": admin_id}
    
    cursor = db.payments.find(query).sort("created_at", -1).limit(100)
    payments = await cursor.to_list(length=100)

    # Load users map for enriching admin information
    users_doc = await db.storages.find_one({"key": "sq_users"})
    user_map = {}
    if users_doc and users_doc.get("val"):
        try:
            u_list = json.loads(users_doc["val"])
            for u in u_list:
                if u.get("id"): user_map[u["id"]] = u
                if u.get("username"): user_map[u["username"]] = u
                if u.get("name"): user_map[u["name"]] = u
        except Exception:
            pass
    
    for p in payments:
        if "_id" in p: p["_id"] = str(p["_id"])
        if "created_at" in p and hasattr(p["created_at"], 'isoformat'):
            p["created_at"] = p["created_at"].isoformat()
        if "paid_at" in p and hasattr(p["paid_at"], 'isoformat'):
            p["paid_at"] = p["paid_at"].isoformat()
        if "failed_at" in p and hasattr(p["failed_at"], 'isoformat'):
            p["failed_at"] = p["failed_at"].isoformat()

        uid = p.get("user_id") or p.get("adminId")
        uinfo = user_map.get(uid, {})
        p["adminName"] = uinfo.get("name") or uid or "Admin"
        p["adminEmail"] = uinfo.get("email") or uinfo.get("username") or "-"
        p["college"] = uinfo.get("college") or "-"
        p["package"] = f"₹{int(p.get('amount', 0)/100)} Quiz Plan" if p.get("amount") else "Standard Plan"
            
        # Attach entitlement info if paid
        if p.get("status") == "paid" and p.get("payment_id"):
            ent = await db.entitlements.find_one({"paymentId": p["payment_id"]})
            if ent:
                p["quizLimit"] = ent.get("quizLimit")
                p["usedQuizzes"] = ent.get("usedQuizzes", 0)
                p["remainingQuizzes"] = ent.get("remainingQuizzes", ent.get("quizLimit", 0))
                p["activationCode"] = ent.get("activationCode", "-")
                p["validityDays"] = ent.get("validityDays", 30)
                p["entitlementStatus"] = ent.get("status", "ACTIVE")
                if "validFrom" in ent and hasattr(ent["validFrom"], 'isoformat'): 
                    p["validFrom"] = ent["validFrom"].isoformat()
                elif "validFrom" in ent:
                    p["validFrom"] = str(ent["validFrom"])
                if "expiresAt" in ent and hasattr(ent["expiresAt"], 'isoformat'): 
                    p["expiresAt"] = ent["expiresAt"].isoformat()
                elif "expiresAt" in ent:
                    p["expiresAt"] = str(ent["expiresAt"])
                
    return {"success": True, "payments": payments}

# ─── ADMIN DETAILS (superadmin only) ────────────────────────────
@app.get("/py-api/admin-details/{admin_id}")
async def get_admin_details(admin_id: str, request: Request, user: dict = Depends(get_current_user)):
    if not user.get('isSuper', False):
        raise HTTPException(status_code=403, detail="Forbidden: Superadmin only")
    
    now = datetime.utcnow()
    
    # Login history
    logins = await db.login_history.find({"adminId": admin_id}).sort("loginAt", -1).to_list(length=50)
    for l in logins:
        l["_id"] = str(l["_id"])
        l["loginAt"] = l["loginAt"].isoformat()
    
    # Payment history
    payments = await db.payments.find({"adminId": admin_id}).sort("created_at", -1).to_list(length=50)
    total_paid = 0
    for p in payments:
        p["_id"] = str(p["_id"])
        if "created_at" in p and hasattr(p["created_at"], 'isoformat'):
            p["created_at"] = p["created_at"].isoformat()
        if "paid_at" in p and hasattr(p["paid_at"], 'isoformat'):
            p["paid_at"] = p["paid_at"].isoformat()
        if p.get("status") == "paid":
            total_paid += p.get("amount", 0)
    
    # Entitlements
    entitlements = await db.entitlements.find({"adminId": admin_id}).sort("validFrom", -1).to_list(length=20)
    active_ent = None
    remaining_quizzes = 0
    for e in entitlements:
        e["_id"] = str(e["_id"])
        if hasattr(e.get("expiresAt"), 'isoformat'):
            e["expiresAt"] = e["expiresAt"].isoformat()
        if hasattr(e.get("validFrom"), 'isoformat'):
            e["validFrom"] = e["validFrom"].isoformat()
        if e.get("status") == "ACTIVE" and e.get("remainingQuizzes", 0) > 0:
            remaining_quizzes += e.get("remainingQuizzes", 0)
            if not active_ent:
                active_ent = e
    
    # Quiz activations
    activations = await db.quiz_activations.find({"adminId": admin_id}).sort("activatedAt", -1).to_list(length=50)
    for a in activations:
        a["_id"] = str(a["_id"])
        if "entitlementId" in a: a["entitlementId"] = str(a["entitlementId"])
        if hasattr(a.get("activatedAt"), 'isoformat'):
            a["activatedAt"] = a["activatedAt"].isoformat()
    
    return {
        "success": True,
        "adminId": admin_id,
        "loginCount": len(logins),
        "lastLogin": logins[0]["loginAt"] if logins else None,
        "logins": logins,
        "payments": payments,
        "totalPaid": total_paid,
        "entitlements": entitlements,
        "activePackage": active_ent is not None,
        "remainingQuizzes": remaining_quizzes,
        "activeEntitlement": active_ent,
        "quizActivations": activations,
        "quizzesonducted": len(activations)
    }

if __name__ == "__main__":
    import uvicorn
    print(f"Starting Python Backend on port {PORT}...")
    uvicorn.run("app:app", host="0.0.0.0", port=PORT, reload=True)
