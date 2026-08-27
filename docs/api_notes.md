# Schedule Delta API

`GET /schedule` accepts repeated `person_id`, `start`, and `end` query
parameters. It requires at least `viewer` and returns only matching shifts,
minimal requested-person records, and the current workspace `revision`.

`POST /schedule/preview` validates a Patch without writing. `PATCH /schedule`
requires `scheduler` or `roster_admin` and writes all Patch entries atomically.
Both endpoints receive this payload:

```json
{
  "expectedRevision": "2026-08-24T10:01:24.382Z",
  "patches": [{
    "action": "replace_assignee",
    "shift_id": "shift-7b6d",
    "old": {
      "person_id": "staff-worker-018",
      "role": "worker",
      "trade_tag": "电工",
      "start_date": "2026-08-25",
      "end_date": "2026-08-25"
    },
    "new": { "person_id": "staff-worker-042" }
  }]
}
```

Allowed actions are `replace_assignee`, `update_window`, and `cancel_shift`.
`old` is a server-verified precondition, not a client hint. A Patch may contain
at most 20 distinct `shift_id` values.

The database locks the workspace revision. A changed revision returns
`409 REVISION_MISMATCH`; a changed target row returns
`409 PATCH_PRECONDITION_FAILED`. In either case it writes no rows.

Other important errors are `404 SHIFT_NOT_FOUND`, `422 SCHEDULING_CONFLICT`,
and `422 PERSON_OR_TRADE_INVALID`. Names must be resolved before a Patch is
created; writes use only anonymous staff IDs.
