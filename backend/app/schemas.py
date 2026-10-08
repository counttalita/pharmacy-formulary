from datetime import date, datetime, timezone
from typing import Annotated

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictBool, field_validator

PositiveQuantity = Annotated[int, Field(strict=True, gt=0, le=2147483647)]
Reference = Annotated[str, Field(min_length=1, max_length=120)]


class CreateRule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    effective_from: date
    max_quantity_per_dispense: PositiveQuantity
    max_quantity_per_30_days: PositiveQuantity
    requires_authorisation: StrictBool


class CreateDispense(BaseModel):
    model_config = ConfigDict(extra="forbid")
    medicine_code: Annotated[str, Field(min_length=1, max_length=80)]
    patient_ref: Reference
    quantity: PositiveQuantity
    dispensed_at: AwareDatetime
    authorisation_ref: Annotated[str, Field(max_length=120)] | None = None
    idempotency_key: Reference

    @field_validator("patient_ref", "medicine_code", "idempotency_key")
    @classmethod
    def validate_nonblank(cls, value):
        """Reject blank identifiers while preserving opaque reference bytes."""
        # Inspect whitespace without changing the caller's reference.
        if not value.strip():
            raise ValueError("Must not be blank")
        return value

    @field_validator("dispensed_at")
    @classmethod
    def normalize_timestamp(cls, value):
        """Canonicalize equivalent offsets before comparing idempotent requests."""
        # Persist and serialize all timestamps in UTC.
        return value.astimezone(timezone.utc)
