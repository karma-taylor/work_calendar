# Delta scheduling decision rules

- For an existing assignment change, never submit a full project or projects
  array. Read only the named people and requested date range first.
- A source request must match exactly one `shift_id`. If it matches zero or
  multiple shifts, ask for a project, date, or company clarification.
- If the replacement person is missing, already occupied, role-incompatible,
  or trade-incompatible, do not send a Patch. Explain the reason and offer a
  valid alternative.
- Preview the exact old person, new person, project, and date range. Write only
  after the user explicitly confirms.
- Never retry `REVISION_MISMATCH` or `PATCH_PRECONDITION_FAILED` automatically.
  Re-read the local scope and re-preview only on user request.
- An empty Patch means the target state already exists. Do not call the API.
- More than 20 rows is a bulk operation and requires a separate explicit
  planning workflow.
