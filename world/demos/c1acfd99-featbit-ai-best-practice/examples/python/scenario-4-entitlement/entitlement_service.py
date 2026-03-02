"""
Scenario 4: AI Application Entitlement Management with Feature Flags

This example demonstrates subscription-based AI feature access control:

- Different features for Free/Pro/Enterprise tiers
- Usage limits based on subscription level
- Dynamic feature gating without code changes
- Easy promotion campaigns (temporary upgrades)

Use case: AI Writing Assistant with tiered subscription plans
"""

from fastapi import FastAPI, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from enum import Enum
import logging
from datetime import datetime

# FeatBit SDK imports
from fbclient import get, set_config
from fbclient.config import Config

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Writing Assistant - Entitlement Management")

# =============================================================================
# FeatBit Configuration
# =============================================================================

ENV_SECRET = "<your-env-secret>"
EVENT_URL = "http://localhost:5100"
STREAMING_URL = "ws://localhost:5100"

config = Config(ENV_SECRET, EVENT_URL, STREAMING_URL)
set_config(config)
fb_client = get()

# Feature Flag Keys
FLAG_BASIC_WRITING = "ai-writing-basic"
FLAG_ADVANCED_WRITING = "ai-writing-advanced"
FLAG_SUMMARY = "ai-summary"
FLAG_CUSTOM_MODEL = "ai-custom-model"
FLAG_USAGE_LIMITS = "ai-usage-limits"

# =============================================================================
# Data Models
# =============================================================================

class SubscriptionTier(str, Enum):
    FREE = "free"
    PRO = "pro"
    ENTERPRISE = "enterprise"

class User(BaseModel):
    user_id: str
    name: str
    email: str
    subscription_tier: SubscriptionTier = SubscriptionTier.FREE
    subscription_start: Optional[datetime] = None
    daily_usage: int = 0
    custom_properties: Dict[str, Any] = {}

class FeatureAccess(BaseModel):
    feature: str
    enabled: bool
    reason: str

class UsageLimits(BaseModel):
    daily_limit: int
    features: List[str]

class EntitlementCheck(BaseModel):
    user_id: str
    subscription_tier: SubscriptionTier
    features: List[FeatureAccess]
    usage: UsageLimits
    can_use_service: bool

class WriteRequest(BaseModel):
    user_id: str
    content: str
    feature_type: str  # "basic", "advanced", "summary", "custom"

class WriteResponse(BaseModel):
    result: str
    feature_used: str
    remaining_usage: int

# =============================================================================
# Feature Flag Integration
# =============================================================================

def build_featbit_user(user: User) -> dict:
    """
    Build FeatBit user object from User model.
    """
    return {
        "key": user.user_id,
        "name": user.name,
        "email": user.email,
        "subscription_tier": user.subscription_tier.value,
        "daily_usage": user.daily_usage,
        "subscription_start": user.subscription_start.isoformat() if user.subscription_start else None,
        **user.custom_properties
    }

def check_feature_access(user: User, flag_key: str) -> FeatureAccess:
    """
    Check if user has access to a specific feature.
    """
    if not fb_client.initialize:
        return FeatureAccess(
            feature=flag_key,
            enabled=False,
            reason="featbit_not_initialized"
        )

    fb_user = build_featbit_user(user)
    detail = fb_client.variation_detail(flag_key, fb_user, default=False)

    return FeatureAccess(
        feature=flag_key,
        enabled=detail.variation,
        reason=detail.reason
    )

def get_usage_limits(user: User) -> UsageLimits:
    """
    Get usage limits based on subscription tier.
    """
    if not fb_client.initialize:
        return UsageLimits(daily_limit=10, features=["basic"])

    fb_user = build_featbit_user(user)
    limits = fb_client.variation(FLAG_USAGE_LIMITS, fb_user, default={
        "daily_limit": 10,
        "features": ["basic"]
    })

    return UsageLimits(
        daily_limit=limits.get("daily_limit", 10),
        features=limits.get("features", ["basic"])
    )

def check_all_entitlements(user: User) -> EntitlementCheck:
    """
    Check all feature entitlements for a user.
    """
    # Check all features
    features = [
        check_feature_access(user, FLAG_BASIC_WRITING),
        check_feature_access(user, FLAG_ADVANCED_WRITING),
        check_feature_access(user, FLAG_SUMMARY),
        check_feature_access(user, FLAG_CUSTOM_MODEL),
    ]

    # Get usage limits
    limits = get_usage_limits(user)

    # Check if user can use service
    can_use = (
        user.daily_usage < limits.daily_limit and
        any(f.enabled for f in features)
    )

    return EntitlementCheck(
        user_id=user.user_id,
        subscription_tier=user.subscription_tier,
        features=features,
        usage=limits,
        can_use_service=can_use
    )

# =============================================================================
# User Storage (In-memory for demo)
# =============================================================================

# In production, this would be a database
_users: Dict[str, User] = {}

def get_or_create_user(user_id: str, tier: SubscriptionTier = SubscriptionTier.FREE) -> User:
    """Get or create user in storage."""
    if user_id not in _users:
        _users[user_id] = User(
            user_id=user_id,
            name=f"User {user_id}",
            email=f"{user_id}@example.com",
            subscription_tier=tier,
            subscription_start=datetime.now()
        )
    return _users[user_id]

# =============================================================================
# AI Service Implementation
# =============================================================================

class AIWritingService:
    """AI Writing Service with feature-based capabilities."""

    @staticmethod
    def basic_writing(content: str) -> str:
        """Basic AI writing assistance."""
        return f"[Basic AI] Enhanced: {content} (with grammar and style improvements)"

    @staticmethod
    def advanced_writing(content: str) -> str:
        """Advanced AI writing with tone and style control."""
        return f"[Advanced AI] Refined: {content} (with tone adjustment, style enhancement, and creative suggestions)"

    @staticmethod
    def summary(content: str) -> str:
        """AI content summarization."""
        return f"[Summary AI] Key points: {content[:50]}... (condensed to essential information)"

    @staticmethod
    def custom_model(content: str) -> str:
        """Custom model for specialized use cases."""
        return f"[Custom AI] Specialized output: {content} (processed with enterprise-custom model)"

ai_service = AIWritingService()

# =============================================================================
# API Endpoints
# =============================================================================

@app.on_event("startup")
async def startup_event():
    if fb_client.initialize:
        logger.info("FeatBit client initialized for entitlement management")
    else:
        logger.warning("FeatBit client not initialized")

@app.on_event("shutdown")
async def shutdown_event():
    fb_client.stop()

@app.post("/api/users", response_model=User)
async def create_user(
    user_id: str,
    name: str,
    email: str,
    tier: SubscriptionTier = SubscriptionTier.FREE
):
    """Create a new user."""
    user = User(
        user_id=user_id,
        name=name,
        email=email,
        subscription_tier=tier,
        subscription_start=datetime.now()
    )
    _users[user_id] = user
    return user

@app.get("/api/users/{user_id}", response_model=User)
async def get_user(user_id: str):
    """Get user details."""
    if user_id not in _users:
        raise HTTPException(status_code=404, detail="User not found")
    return _users[user_id]

@app.put("/api/users/{user_id}/subscription")
async def update_subscription(user_id: str, tier: SubscriptionTier):
    """Update user subscription tier."""
    if user_id not in _users:
        raise HTTPException(status_code=404, detail="User not found")

    user = _users[user_id]
    user.subscription_tier = tier
    user.subscription_start = datetime.now()
    return {"status": "updated", "tier": tier.value}

@app.get("/api/users/{user_id}/entitlements", response_model=EntitlementCheck)
async def get_entitlements(user_id: str):
    """
    Get all entitlements for a user.
    This is the key endpoint for checking feature access.
    """
    if user_id not in _users:
        raise HTTPException(status_code=404, detail="User not found")

    user = _users[user_id]
    return check_all_entitlements(user)

@app.post("/api/write", response_model=WriteResponse)
async def write_content(request: WriteRequest):
    """
    Use AI writing features based on entitlements.
    """
    # Get user
    user = get_or_create_user(request.user_id)

    # Check entitlements
    entitlements = check_all_entitlements(user)

    # Check if feature is accessible
    feature_flag_map = {
        "basic": FLAG_BASIC_WRITING,
        "advanced": FLAG_ADVANCED_WRITING,
        "summary": FLAG_SUMMARY,
        "custom": FLAG_CUSTOM_MODEL,
    }

    flag_key = feature_flag_map.get(request.feature_type)
    if not flag_key:
        raise HTTPException(status_code=400, detail="Invalid feature type")

    feature_access = check_feature_access(user, flag_key)
    if not feature_access.enabled:
        raise HTTPException(
            status_code=403,
            detail=f"Feature '{request.feature_type}' not available for your subscription tier. Reason: {feature_access.reason}"
        )

    # Check usage limit
    limits = get_usage_limits(user)
    if user.daily_usage >= limits.daily_limit:
        raise HTTPException(
            status_code=429,
            detail=f"Daily usage limit ({limits.daily_limit}) exceeded. Upgrade your subscription for more."
        )

    # Execute feature
    feature_handlers = {
        "basic": ai_service.basic_writing,
        "advanced": ai_service.advanced_writing,
        "summary": ai_service.summary,
        "custom": ai_service.custom_model,
    }

    result = feature_handlers[request.feature_type](request.content)

    # Update usage
    user.daily_usage += 1

    return WriteResponse(
        result=result,
        feature_used=request.feature_type,
        remaining_usage=limits.daily_limit - user.daily_usage
    )

@app.post("/api/users/{user_id}/reset-usage")
async def reset_daily_usage(user_id: str):
    """Reset daily usage counter (typically called by cron job)."""
    if user_id not in _users:
        raise HTTPException(status_code=404, detail="User not found")

    _users[user_id].daily_usage = 0
    return {"status": "reset", "user_id": user_id}

# =============================================================================
# Promotion Campaign Endpoint
# =============================================================================

@app.post("/api/promotions/upgrade")
async def create_temporary_upgrade(
    user_id: str,
    feature: str,
    duration_hours: int = 24
):
    """
    Create a temporary feature upgrade for a user.
    This is done by adding a custom property to the user.

    In production, you might use:
    - Scheduled flag changes in FeatBit
    - User segments with expiration
    - Custom targeting rules
    """
    if user_id not in _users:
        raise HTTPException(status_code=404, detail="User not found")

    user = _users[user_id]
    promotion_key = f"promotion_{feature}"
    user.custom_properties[promotion_key] = True
    user.custom_properties[f"{promotion_key}_expires"] = (
        datetime.now().isoformat()
    )

    return {
        "status": "upgraded",
        "user_id": user_id,
        "feature": feature,
        "duration_hours": duration_hours
    }

# =============================================================================
# Running the Application
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    print("""
    ╔══════════════════════════════════════════════════════════════╗
    ║   AI Writing Assistant - Entitlement Management             ║
    ╠══════════════════════════════════════════════════════════════╣
    ║   Endpoints:                                                 ║
    ║   - POST   /api/users                  - Create user        ║
    ║   - GET    /api/users/{id}             - Get user           ║
    ║   - PUT    /api/users/{id}/subscription - Update tier       ║
    ║   - GET    /api/users/{id}/entitlements - Check access      ║
    ║   - POST   /api/write                  - Use AI features    ║
    ║   - POST   /api/promotions/upgrade     - Temp upgrade       ║
    ║                                                              ║
    ║   Subscription Tiers:                                        ║
    ║   - Free: Basic writing only, 10/day                        ║
    ║   - Pro: + Advanced writing, Summary, 100/day               ║
    ║   - Enterprise: + Custom model, Unlimited                   ║
    ╚══════════════════════════════════════════════════════════════╝
    """)

    uvicorn.run(app, host="0.0.0.0", port=8003)
