class ApiError(Exception):
    def __init__(self, status, code, field, message):
        """Carry a stable field-level error across the service boundary."""
        # Preserve the human-readable exception message for debugging.
        super().__init__(message)
        self.status = status
        self.body = {"errors": [{"code": code, "field": field, "message": message}]}


def describe_validation(error):
    """Translate Pydantic details into the API's consistent error contract."""
    # Omit Pydantic context because it can contain non-JSON Python exceptions.
    return [{"code": "invalid_input", "field": ".".join(str(part) for part in item["loc"] if part != "body") or "body",
             "message": item["msg"]} for item in error.errors()]
