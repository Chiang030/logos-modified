## Development Mode Execution Workflow

Development mode is used for code-development tasks such as custom solvers, custom libraries, and post-processing tools for relevant open-source software. Development mode does not replace usage mode; it focuses on whether the "code capability" itself is correct, stable, compilable, and callable by cases.

### Stage D1: Requirement and Boundary Confirmation

- Objective: convert the user request into a clear development task boundary.
- Input: user request, `Ref/` materials, existing `UDF/README.md`, backend-software tutorials, and public documentation or papers when needed.
- Actions:
  - Identify the task type. Develop through the open-source software interface specified by the user or judged by you to be most suitable, and read the corresponding skill.
  - Clarify target capability, inputs and outputs, applicable physical model, expected integration method, and validation case.
  - If the request affects theoretical formulas, discretization schemes, conservation, dimensions, or stability, read code and references before designing; do not write directly from experience.
  - If information is insufficient, ask the user using the "Parameter name / Purpose / Explanation / Recommendation" template.
- Output: development objectives, scope, non-goals, and acceptance criteria written to or updated in `UDF/README.md`.

### Stage D2: Development Design Document

- Objective: make the implementation plan clear before modifying code.
- Actions:
  - Read the backend software codebase, skill, manuals, guides, and related materials.
  - Complete the document in `UDF/README.md`: mathematical model, key classes/files, interfaces, run method, build method, validation method, and risks.
- Output: reviewable `UDF/README.md` development documentation.

### Stage D3: Implementation and Organization

- Objective: create maintainable, compilable, reusable development artifacts under `UDF/`.
- Actions:
  - Develop according to the backend software codebase, skill, manuals, guides, and README.md document.
  - Strictly follow code conventions and provide an implementation that matches the document.
- Output: source code under `UDF/`.

### Stage D4: Compilation and Minimal Validation

- Objective: prove that the code can compile and be loaded in the current environment.
- Actions:
  - Load the backend software environment, compile, and organize build logs and errors into `UDF/README.md`; place long logs under `UDF/logs/` when they need to be preserved.
  - If errors occur, read logs and references carefully and solve them deeply.
  - Perform at least one lightweight validation or enter reasonable iterations on a minimal case.
- Output: compilation result, command record, error-fix record, and minimal validation result.

### Stage D5: Case Integration and Delivery

- Objective: integrate the development result into the target case or form a reusable deliverable.
- Actions:
  - If the user requests use in the current case, update the relevant physical dictionaries and run scripts under `C-run/case-*` to use the new solver/library.
  - Keep UDF code and case dictionaries decoupled: source stays under `UDF/`.
  - Clearly document in `UDF/README.md`: how to compile, how to enable it, which dictionaries it depends on, what has been validated, and what risks remain.
  - If the development result supports a usage-mode stage, also update the corresponding record and `workflowState` in `0-caseDict/caseDict`.
- Output: reproducible UDF source code, build instructions, integration instructions, validation records, and delivery summary.

### Development Mode Completion Conditions

- `UDF/README.md` records the requirement, design, usage method, and validation results.
- The relevant `UDF/` code structure is clear and files are complete.
- Necessary compilation and validation have been executed.

