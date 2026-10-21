---
name: logos-simulation-workflow
description: Use for simulation-case execution or solver/UDF development, including caseDict, geometry, meshing, solving, post-processing and reporting. Does not apply to development of the LOGOS agent runtime itself.
---

# LOGOS Simulation Workflow

Read [general rules](references/general.md) first, then choose the relevant mode:

For installation selection, session lifecycle and shared execution decisions,
use [sim-cli](../sim-cli/SKILL.md); this skill owns the case workflow and stage
handoffs, not tool implementation.

- Solver, library or post-processing tool development: read [development workflow](references/development.md).
- Simulation-case execution: read [usage workflow](references/usage.md).
- To select domain skills, consult [domain skill names](references/domain-skills.md) and use only skills available in the runtime.

Studio preview executors, `ctx` APIs, environment variables and automatic GUI execution described in the references originate from the supplied example. Verify the corresponding integration exists before using those instructions; do not claim LOGOS implements them. For tool paths, consult [historical toolchain](../../references/toolchain.md) and verify the current environment.
