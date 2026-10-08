# Implementation Order

Give Claude Code the documents in this exact order:

1. 00_MASTER_IMPLEMENTATION_MANIFEST.md
2. V0_Platform_Foundation.md
3. V1_Core_Bookkeeping.md
4. V2_Accounts_Production_FRS102_FRS105.md
5. V3_iXBRL_Companies_House.md
6. V4_Corporation_Tax_HMRC.md
7. V5_VAT_MTD_HMRC_Services.md
8. V6_AI_OCR_Automation.md
9. V7_Practice_Management_Client_Portal_Compliance.md
10. V8_Working_Papers_Review_QC.md
11. V9_CFO_Forecasting_Financial_Intelligence.md
12. V10_AI_Accountant_Autonomous_Workflows.md
13. V11_Integrations_Migration_Ecosystem.md
14. V12_Benchmarking_Marketplace_Ecosystem.md
15. 13_CROSS_PLATFORM_PRODUCT_REQUIREMENTS.md

## Instruction to Claude Code
Do not rebuild the application from scratch at each stage.

At every stage:
- inspect the existing repository;
- preserve the established architecture;
- create/update migrations;
- reuse existing services;
- run all previous tests;
- implement the new version;
- add tests;
- document APIs;
- report blockers before making architectural compromises.

## Important
V0 is intentionally introduced before bookkeeping. It prevents the later modules from becoming a collection of disconnected features.
