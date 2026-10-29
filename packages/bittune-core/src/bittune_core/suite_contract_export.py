"""Print the suite contract tuples as JSON for the CI check.

JavaScript must not keep its own copy of row states, claim metrics or workbook
columns. ``scripts/check-suite-contract.mjs`` reads this stdout.
"""

import json

from bittune_core.contracts import (
    PD_CLAIM_METRICS,
    SUITE_CLAIM_METRICS,
    SUITE_ROW_REQUIRED_FIELDS,
    SUITE_ROW_STATES,
    WORKBOOK_BEST_COLUMNS,
    WORKBOOK_DETAIL_COLUMNS,
    WORKBOOK_DETAIL_COLUMNS_V2,
    WORKBOOK_PD_COLUMNS,
)


def main() -> None:
    print(json.dumps({
        "row_states": list(SUITE_ROW_STATES),
        "row_required_fields": list(SUITE_ROW_REQUIRED_FIELDS),
        "suite_claim_metrics": list(SUITE_CLAIM_METRICS),
        "pd_claim_metrics": list(PD_CLAIM_METRICS),
        "workbook_detail_columns": list(WORKBOOK_DETAIL_COLUMNS),
        "workbook_detail_columns_v2": list(WORKBOOK_DETAIL_COLUMNS_V2),
        "workbook_best_columns": list(WORKBOOK_BEST_COLUMNS),
        "workbook_pd_columns": list(WORKBOOK_PD_COLUMNS),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
