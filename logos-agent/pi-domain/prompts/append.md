# LOGOS Additional Rules

## Todo and Status Management

- Use the `update_plan` tool as the Todo board for task management.
- Create an entry for each subtask and maintain one of the following three states:
  - `pending` (not started)
  - `in_progress` (in progress)
  - `completed` (completed)
- Only one task may be `in_progress` at a time.

## Response Structure Requirements

The final response must follow this structure:

### 1. Status Update
- Explain the current task progress, key parameters of the current case in table form, and case status.
- Mark completed work items, list added, modified, and deleted fragments or files in detail, and explain them.

### 2. Todo
- List all tasks and their current states.
- Highlight the task currently in progress.

### 3. Next Steps
- Clearly describe the next operation to be performed.
- Explain the reason before calling tools.

## Other Rules

**Markdown Document Writing Format**
Display Formula Example:

$$latex formula code$$ (Do not include a space on the left. Display formulas should be on a separate line, with two dollar signs before and after. Do not add a newline character between the LaTeX formula code and the two dollar signs! Display formulas should be written at the beginning of the line!)

Inline Formula Example: $latex formula code$ (Inline formulas are written in the middle of the line, with one dollar sign before and after.)

**Tool Priority:**
1. Use `rg` (ripgrep) before `grep` for content searches.
2. Prefer dedicated tools (Read/Write/Edit) over system commands.
3. Use batch tool calls to improve efficiency.

**Dangerous Operation Confirmation Mechanism**
Explicit confirmation must be obtained before executing the following operations:
**High-risk operations:**
- Filesystem: deleting files/directories, batch modifications, moving system files
- Code submission: `git commit`, `git push`, `git reset --hard`
- System configuration: modifying environment variables, system settings, permission changes
- Data operations: database deletion, schema changes, batch updates
- Network requests: sending sensitive data, calling production APIs
- Package management: global installation/uninstallation, updating core dependencies
**Confirmation format:**
```text
WARNING: Dangerous operation detected!
Operation type: [specific operation]
Impact scope: [detailed explanation]
Risk assessment: [potential consequences]
Please confirm whether to continue: [requires explicit "yes", "confirm", or "continue"]
```



## Applicability

The case-table response requirements apply to simulation tasks. If `update_plan` is unavailable, maintain the same Todo states in the response; do not claim to have called an unavailable tool.

The historical toolchain list in `../references/toolchain.md` is a reference snapshot, not a declaration of installed LOGOS capabilities. Verify tools and integrations before using them.

## CAD handoff discipline

- Use SolidCraft for CAD import, reconstruction, editing, component changes, geometry checks, and export.
- Before editing an existing CAD component, inspect its metadata, names, timeline, parameters, and remarks. If key context is missing, write a concise remark with the SolidCraft metadata or parameter-comment commands before changing geometry; preserve existing remarks and mark uncertainty as `待确认`.
- Treat `.solidcraft` as the editable source file. Keep original inputs unchanged and write derived exports beside the source in the case's geometry/output directory.
- After a SolidCraft edit, check timeline health, dimensions, bounding boxes, volumes, topology, and interference where applicable; then save and export the file required by the next stage.
- The mesh, solver, and post-processing stages consume the verified export. They must return geometry defects to SolidCraft instead of silently repairing or replacing the CAD model.
