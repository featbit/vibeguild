"""
Scenario 3: AI Function Remote Configuration with Feature Flags

This example demonstrates how to use FeatBit for dynamic AI configuration:
- Temperature, max tokens, system prompts
- Fallback model configuration
- Rate limits and cost thresholds

All configuration changes take effect in real-time without redeployment.

Use case: Dynamically adjusting AI model parameters based on performance
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any
import logging
import json

# FeatBit SDK imports
from fbclient import get, set_config
from fbclient.config import Config

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Remote Configuration Service")

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
FLAG_AI_CONFIG = "ai-config"

# =============================================================================
# Data Models
# =============================================================================

class AIConfig(BaseModel):
    """AI configuration structure"""
    model: str = "gpt-4-turbo"
    temperature: float = 0.7
    max_tokens: int = 2000
    system_prompt: str = "You are a helpful assistant."
    fallback_model: str = "gpt-3.5-turbo"
    rate_limit_per_user: int = 100
    cost_alert_threshold: float = 0.05
    enable_streaming: bool = True
    safety_filters: list[str] = ["hate_speech", "violence"]

class ChatRequest(BaseModel):
    user_id: str
    message: str
    override_config: Optional[Dict[str, Any]] = None

class ChatResponse(BaseModel):
    response: str
    config_used: AIConfig
    model_used: str
    config_source: str  # "featbit" or "default"

# =============================================================================
# Configuration Management
# =============================================================================

# Default configuration (fallback when FeatBit is unavailable)
DEFAULT_CONFIG = AIConfig()

# In-memory cache for configuration
_config_cache: Dict[str, AIConfig] = {}

def get_ai_config(user_id: str = "default", environment: str = "production") -> tuple[AIConfig, str]:
    """
    Get AI configuration for the specified environment.

    Returns:
        tuple: (config, source)
    """
    if not fb_client.initialize:
        logger.warning("FeatBit not initialized, using default config")
        return DEFAULT_CONFIG, "default"

    user = {
        "key": user_id,
        "name": user_id,
        "environment": environment,
    }

    # Get JSON configuration from flag
    detail = fb_client.variation_detail(
        FLAG_AI_CONFIG,
        user,
        default=DEFAULT_CONFIG.model_dump()
    )

    try:
        config_dict = detail.variation
        if isinstance(config_dict, str):
            config_dict = json.loads(config_dict)

        config = AIConfig(**config_dict)
        logger.info(f"Loaded AI config for {environment}: model={config.model}, temp={config.temperature}")
        return config, "featbit"

    except Exception as e:
        logger.error(f"Failed to parse config: {e}, using default")
        return DEFAULT_CONFIG, "default"

def update_config_cache(config: AIConfig):
    """
    Update the local configuration cache.
    """
    global _config_cache
    _config_cache["latest"] = config

# =============================================================================
# AI Service Implementation
# =============================================================================

class AIService:
    """
    AI Service that uses remote configuration.
    """

    def __init__(self):
        self._current_config: Optional[AIConfig] = None
        self._usage_tracker: Dict[str, int] = {}

    @property
    def config(self) -> AIConfig:
        """Get current configuration, refreshing from FeatBit if needed."""
        if self._current_config is None:
            self._current_config, _ = get_ai_config()
        return self._current_config

    def refresh_config(self):
        """Force refresh configuration from FeatBit."""
        self._current_config, source = get_ai_config()
        logger.info(f"Configuration refreshed from {source}")
        return self._current_config

    def check_rate_limit(self, user_id: str) -> bool:
        """Check if user has exceeded rate limit."""
        config = self.config
        usage = self._usage_tracker.get(user_id, 0)
        return usage < config.rate_limit_per_user

    def increment_usage(self, user_id: str):
        """Increment usage counter for user."""
        self._usage_tracker[user_id] = self._usage_tracker.get(user_id, 0) + 1

    def generate_response(self, message: str, config: AIConfig) -> str:
        """
        Generate AI response using the specified configuration.
        """
        # In production, this would call the actual AI API
        # with the specified temperature, max_tokens, etc.

        # Simulate API call with config
        response = f"""
        [AI Response using {config.model}]
        Temperature: {config.temperature}
        Max Tokens: {config.max_tokens}
        System Prompt: {config.system_prompt}

        User message: {message}

        Response generated with configured parameters.
        """
        return response.strip()

# Global AI service instance
ai_service = AIService()

# =============================================================================
# Flag Change Listener
# =============================================================================

def on_config_changed(flag_key: str, new_config: dict):
    """
    Handle configuration changes in real-time.
    """
    logger.info(f"Configuration flag '{flag_key}' changed")

    try:
        if isinstance(new_config, str):
            new_config = json.loads(new_config)

        config = AIConfig(**new_config)
        ai_service._current_config = config
        update_config_cache(config)

        # Log important changes
        logger.info(f"New config applied: model={config.model}, temp={config.temperature}")

        # In production, you might:
        # - Alert monitoring systems
        # - Update metrics
        # - Notify relevant teams

    except Exception as e:
        logger.error(f"Failed to apply new config: {e}")

# Register configuration change listener
if fb_client.initialize:
    sample_user = {"key": "config-listener", "name": "Config Listener"}
    fb_client.flag_tracker.add_flag_value_changed_listener(
        FLAG_AI_CONFIG,
        sample_user,
        on_config_changed
    )

# =============================================================================
# API Endpoints
# =============================================================================

@app.on_event("startup")
async def startup_event():
    if fb_client.initialize:
        # Initialize config on startup
        ai_service.refresh_config()
        logger.info("AI Service initialized with FeatBit configuration")
    else:
        logger.warning("FeatBit not initialized, using default configuration")

@app.on_event("shutdown")
async def shutdown_event():
    fb_client.stop()

@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Chat endpoint using remotely configured AI parameters.
    """
    # Check rate limit
    if not ai_service.check_rate_limit(request.user_id):
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Please try again later."
        )

    # Get configuration
    config = ai_service.config

    # Allow per-request config override (useful for testing)
    if request.override_config:
        override_dict = config.model_dump()
        override_dict.update(request.override_config)
        config = AIConfig(**override_dict)

    # Generate response
    response = ai_service.generate_response(request.message, config)

    # Track usage
    ai_service.increment_usage(request.user_id)

    return ChatResponse(
        response=response,
        config_used=config,
        model_used=config.model,
        config_source="featbit" if fb_client.initialize else "default"
    )

@app.get("/api/config")
async def get_current_config():
    """
    Get the current AI configuration.
    """
    config = ai_service.config
    return {
        "config": config.model_dump(),
        "source": "featbit" if fb_client.initialize else "default"
    }

@app.post("/api/config/refresh")
async def refresh_config():
    """
    Force refresh configuration from FeatBit.
    """
    config = ai_service.refresh_config()
    return {
        "status": "refreshed",
        "config": config.model_dump()
    }

@app.get("/api/usage/{user_id}")
async def get_user_usage(user_id: str):
    """
    Get usage statistics for a user.
    """
    usage = ai_service._usage_tracker.get(user_id, 0)
    limit = ai_service.config.rate_limit_per_user

    return {
        "user_id": user_id,
        "current_usage": usage,
        "limit": limit,
        "remaining": max(0, limit - usage)
    }

# =============================================================================
# Configuration Validation Endpoint
# =============================================================================

@app.post("/api/config/validate")
async def validate_config(config: AIConfig):
    """
    Validate a configuration before applying it.
    """
    errors = []

    if not 0 <= config.temperature <= 2:
        errors.append("temperature must be between 0 and 2")

    if not 1 <= config.max_tokens <= 128000:
        errors.append("max_tokens must be between 1 and 128000")

    if config.rate_limit_per_user < 0:
        errors.append("rate_limit_per_user must be non-negative")

    if config.cost_alert_threshold <= 0:
        errors.append("cost_alert_threshold must be positive")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "config": config.model_dump()
    }

# =============================================================================
# Running the Application
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    print("""
    ╔══════════════════════════════════════════════════════════════╗
    ║   AI Remote Configuration Service                           ║
    ╠══════════════════════════════════════════════════════════════╣
    ║   Endpoints:                                                 ║
    ║   - POST /api/chat           - Chat with configured AI      ║
    ║   - GET  /api/config         - Get current config           ║
    ║   - POST /api/config/refresh - Force config refresh         ║
    ║   - GET  /api/usage/{user}   - Get user usage               ║
    ║   - POST /api/config/validate - Validate config             ║
    ║                                                              ║
    ║   Configuration updates in real-time via FeatBit!           ║
    ╚══════════════════════════════════════════════════════════════╝
    """)

    uvicorn.run(app, host="0.0.0.0", port=8002)
