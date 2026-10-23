import json
import logging
from datetime import datetime, timezone
from typing import Annotated
from uuid import uuid4

from fastapi import FastAPI, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from app.catalogue import list_dispenses, list_medicines, require_medicine
from app.database import fetch_all, fetch_one, get_engine
from app.dispenses import capture_dispense, record_outcome
from app.errors import ApiError, describe_validation
from app.rules import find_rule, supersede_rule
from app.schemas import CreateDispense, CreateRule, FormularyRule, RuleHistoryResponse

# Construct the API and reusable query constraints.
app = FastAPI(title="Pharmacy formulary", version="1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
PageLimit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=2048)]


@app.exception_handler(ApiError)
async def handle_api_error(request, error):
    """Expose service errors without losing their field and rule identifiers."""
    # Serialize the service's stable error envelope.
    return JSONResponse(error.body, status_code=error.status)


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request, error):
    """Use the same envelope for route, body and query validation."""
    # Translate validation details into frontend-addressable fields.
    return JSONResponse({"errors": describe_validation(error)}, status_code=422)


@app.exception_handler(HTTPException)
async def handle_http_error(request, error):
    """Normalize missing routes and other framework HTTP errors."""
    # Keep framework errors compatible with the frontend renderer.
    return JSONResponse({"errors": [{"code": "http_error", "field": "body", "message": str(error.detail)}]}, status_code=error.status_code)


@app.exception_handler(IntegrityError)
async def handle_integrity_error(request, error):
    """Hide SQL details while reporting a rejected database invariant."""
    # Database errors have already rolled back their transaction.
    return JSONResponse({"errors": [{"code": "data_conflict", "field": "body", "message": "This operation conflicts with existing data."}]}, status_code=409)


@app.exception_handler(Exception)
async def handle_unexpected_error(request, error):
    """Keep unexpected failures observable without exposing database internals."""
    # Log the exception server-side and return the common error shape.
    logging.getLogger(__name__).error("Request failed", exc_info=error)
    return JSONResponse({"errors": [{"code": "internal_error", "field": "body", "message": "The request could not be completed."}]}, status_code=500)


@app.get("/api/v1/health")
def check_health():
    """Report readiness only when the database connection is usable."""
    # Check the same pool used by API operations.
    with get_engine().connect() as connection:
        fetch_one(connection, "SELECT 1")
    return {"status": "ok"}


@app.get("/api/v1/medicines")
def search_medicines(q: Annotated[str, Query(max_length=200)] = "", limit: PageLimit = 20, cursor: Cursor = None):
    """Search the catalogue by partial name or code."""
    # Keep each listing within one short-lived read connection.
    with get_engine().connect() as connection:
        return list_medicines(connection, q, limit, cursor)


@app.get("/api/v1/medicines/{code}")
def get_medicine(code: str):
    """Return a medicine and the rule currently in force."""
    # Resolve the medicine before querying the current temporal rule.
    with get_engine().connect() as connection:
        medicine = require_medicine(connection, code)
        medicine["current_rule"] = find_rule(connection, medicine["id"], datetime.now(timezone.utc))
        return medicine


@app.get("/api/v1/medicines/{code}/rules", response_model=RuleHistoryResponse, summary="Get rule history")
def get_rule_history(code: str):
    """Return the complete ordered timeline of formulary rules for a medicine, explicitly marking the current rule."""
    # The brief requests full history, so this small per-medicine list is unpaginated.
    with get_engine().connect() as connection:
        medicine = require_medicine(connection, code)
        return {"items": fetch_all(connection, """
            SELECT *, tstzrange(effective_from,effective_to,'[)') @> now() AS is_current
            FROM formulary_rule WHERE medicine_id=:medicine ORDER BY effective_from,id
        """, {"medicine": medicine["id"]})}


@app.post("/api/v1/medicines/{code}/rules", status_code=201, response_model=FormularyRule, summary="Add or update a formulary rule")
def create_rule(code: str, request: CreateRule):
    """Introduce a new rule version from a Johannesburg calendar date.

    - Interprets the date as midnight Africa/Johannesburg (UTC+02:00).
    - Supersedes the containing period, shortening its `effective_to` without mutating earlier dispenses.
    - Preserves any already scheduled future versions.
    - Validates business constraints:
      - Returns 404 (`medicine_not_found`) if the medicine code does not exist.
      - Returns 409 (`rule_start_conflict`) if a version already starts on this date.
      - Returns 422 (`rolling_below_single`) if `max_quantity_per_30_days` < `max_quantity_per_dispense`.
      - Returns 422 (`rule_unchanged`) if the new version identical to the superseded period.
      - Returns 422 (`invalid_input`) if quantities are non-positive or dates are outside 2000-2100.
    """
    # Delegate transaction ownership to the versioning service.
    return supersede_rule(get_engine(), code, request)


def reject_malformed_json(raw_body):
    """Persist a parsing failure even when no usable idempotency key is available."""
    # An unparseable body receives its own non-replayable audit identity.
    with get_engine().begin() as connection:
        return record_outcome(connection, f"invalid-{uuid4()}", {"raw_body": raw_body}, 422,
                              {"errors": [{"code": "invalid_json", "field": "body", "message": "Request body must be valid JSON."}]})


@app.post("/api/v1/dispenses", openapi_extra={"requestBody": {
    "required": True, "content": {"application/json": {"schema": CreateDispense.model_json_schema()}}
}})
async def create_dispense(request: Request):
    """Persist both valid and invalid dispense submissions and replay their outcomes."""
    # Parse on the event loop, then run blocking database work in FastAPI's worker pool.
    raw = await request.body()
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError):
        status, body = await run_in_threadpool(reject_malformed_json, raw.decode(errors="replace"))
    else:
        status, body = await run_in_threadpool(capture_dispense, get_engine(), payload)
    return JSONResponse(jsonable_encoder(body), status_code=status)


@app.get("/api/v1/dispenses")
def get_dispenses(patient_ref: Annotated[str | None, Query(max_length=120)] = None,
                  medicine: Annotated[str | None, Query(max_length=80)] = None,
                  limit: PageLimit = 20, cursor: Cursor = None):
    """Read paginated history filtered by an exact patient reference or medicine code."""
    # Keep opaque references unchanged when applying the ledger filter.
    with get_engine().connect() as connection:
        return list_dispenses(connection, patient_ref, medicine, limit, cursor)
