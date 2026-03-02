"""
Scenario 1: AI Model Safe Release with Feature Flags

This example demonstrates how to safely release a new AI model using FeatBit
Feature Flags with gradual rollout and instant rollback capability.

Use case: Rolling out GPT-4 based customer service AI to replace GPT-3.5
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import logging

# FeatBit SDK imports
from fbclient import get, set_config
from fbclient.config import Config

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Customer Service API")

# =============================================================================
# FeatBit Configuration
# =============================================================================

# Initialize FeatBit client (do this once at application startup)
ENV_SECRET = "<your-env-secret>"
EVENT_URL = "http://localhost:5100"
STREAMING_URL = "ws://localhost:5100"

# Configure and initialize the SDK
config = Config(ENV_SECRET, EVENT_URL, STREAMING_URL)
set_config(config)
fb_client = get()

# Feature Flag Keys
FLAG_AI_V2_ENABLED = "ai-customer-service-v2"

# =============================================================================
# AI Service Layer (Mock implementations for demonstration)
# =============================================================================

class ChatRequest(BaseModel):
    user_id: str
    message: str
    context: Optional[dict] = None

class ChatResponse(BaseModel):
    response: str
    model_used: str
    flag_evaluation_reason: str

def get_legacy_ai_response(message: str, context: Optional[dict] = None) -> str:
    """
    Legacy AI model (GPT-3.5) - stable and well-tested
    """
    # In production, this would call the actual AI API
    return f"[GPT-3.5 Response] I understand you said: '{message}'. How can I help you further?"

def get_v2_ai_response(message: str, context: Optional[dict] = None) -> str:
    """
    New AI model (GPT-4) - more capable but needs testing
    """
    # In production, this would call the actual AI API
    return f"[GPT-4 Response] Based on your message '{message}', I've analyzed the context and can provide more nuanced assistance..."

# =============================================================================
# Feature Flag Integration
# =============================================================================

def get_ai_model_for_user(user_id: str, user_attributes: Optional[dict] = None) -> tuple[bool, str]:
    """
    Evaluate which AI model to use for a given user.

    Returns:
        tuple: (use_v2_model: bool, reason: str)
    """
    if not fb_client.initialize:
        logger.warning("FeatBit client not initialized, using legacy model")
        return False, "client_not_initialized"

    # Build user object for FeatBit
    user = {
        "key": user_id,
        "name": user_attributes.get("name", user_id) if user_attributes else user_id,
    }

    # Add custom attributes if provided
    if user_attributes:
        for key, value in user_attributes.items():
            if key not in ["key", "name"]:
                user[key] = value

    # Get flag variation with detailed reason
    detail = fb_client.variation_detail(FLAG_AI_V2_ENABLED, user, default=False)

    logger.info(f"Flag evaluation for user {user_id}: {detail.variation}, reason: {detail.reason}")

    return detail.variation, detail.reason

# =============================================================================
# API Endpoints
# =============================================================================

@app.on_event("startup")
async def startup_event():
    """
    Verify FeatBit client is ready at startup
    """
    if fb_client.initialize:
        logger.info("FeatBit client initialized successfully")
    else:
        logger.warning("FeatBit client not initialized - using fallback behavior")

@app.on_event("shutdown")
async def shutdown_event():
    """
    Gracefully shutdown FeatBit client
    """
    fb_client.stop()
    logger.info("FeatBit client stopped")

@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Main chat endpoint that uses Feature Flags to determine which AI model to use.
    """
    # Evaluate feature flag
    use_v2_model, reason = get_ai_model_for_user(
        request.user_id,
        request.context
    )

    # Get response from appropriate AI model
    if use_v2_model:
        response_text = get_v2_ai_response(request.message, request.context)
        model_used = "gpt-4"
    else:
        response_text = get_legacy_ai_response(request.message, request.context)
        model_used = "gpt-3.5"

    return ChatResponse(
        response=response_text,
        model_used=model_used,
        flag_evaluation_reason=reason
    )

@app.get("/api/health")
async def health_check():
    """
    Health check endpoint including FeatBit status
    """
    return {
        "status": "healthy",
        "featbit_initialized": fb_client.initialize
    }

@app.get("/api/flag-status/{user_id}")
async def get_flag_status(user_id: str):
    """
    Debug endpoint to check flag status for a user
    """
    use_v2_model, reason = get_ai_model_for_user(user_id)
    return {
        "user_id": user_id,
        "flag_key": FLAG_AI_V2_ENABLED,
        "use_v2_model": use_v2_model,
        "reason": reason
    }

# =============================================================================
# Flag Change Listener (for real-time updates)
# =============================================================================

def on_flag_changed(flag_key: str, new_value: bool):
    """
    Callback for when flag value changes.
    Useful for logging, metrics, or cache invalidation.
    """
    logger.info(f"Flag '{flag_key}' changed to: {new_value}")

    # In production, you might want to:
    # - Update metrics
    # - Invalidate caches
    # - Notify monitoring systems
    # - Log the change for audit

# Register flag change listener
if fb_client.initialize:
    sample_user = {"key": "sample-user", "name": "Sample User"}
    fb_client.flag_tracker.add_flag_value_changed_listener(
        FLAG_AI_V2_ENABLED,
        sample_user,
        on_flag_changed
    )

# =============================================================================
# Running the Application
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    print("""
    ╔══════════════════════════════════════════════════════════════╗
    ║   AI Customer Service API - Safe Release Demo               ║
    ╠══════════════════════════════════════════════════════════════╣
    ║   Endpoints:                                                 ║
    ║   - POST /api/chat         - Send chat message              ║
    ║   - GET  /api/health       - Health check                   ║
    ║   - GET  /api/flag-status/{user_id} - Check flag status     ║
    ║                                                              ║
    ║   Feature Flag: ai-customer-service-v2                       ║
    ║   - true:  Use GPT-4 (new model)                            ║
    ║   - false: Use GPT-3.5 (legacy model)                       ║
    ╚══════════════════════════════════════════════════════════════╝
    """)

    uvicorn.run(app, host="0.0.0.0", port=8000)
