# Community personal records

`personal-records-latest.json` is the latest validated personal-record export collected by the project's long-running SaltyBetBot instance. It uses the extension's normal import format and can be loaded with **Import** in the popup.

The companion `personal-records-metadata.json` reports the record count, date range, SHA-256 checksum, and generation time. The publication job refuses empty, malformed, out-of-order, or regressed exports. It pushes a dedicated automation branch, and GitHub merges it into `master` only after the project's required verification passes. Git history preserves earlier versions of both files.

These records are separate from the immutable 458,292-match bundled baseline. They include the collector's historical virtual wager and balance fields and are intentionally published as public project data.
