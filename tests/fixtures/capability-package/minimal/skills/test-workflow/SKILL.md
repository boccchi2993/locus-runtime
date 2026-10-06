# Test Workflow (TEST ONLY fixture)

This guidance file is a build fixture for the capability package core.

1. Import the plugin module `locus_test_plugin` (preinstalled before READY).
2. Call `locus_test_plugin.answer()` and expect `42`.
3. Never fetch anything from the network; the plugin boundary is offline.

This file is not a production skill and belongs to no production catalog.
