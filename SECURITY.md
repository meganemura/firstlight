# Security

Report a vulnerability through GitHub's private vulnerability reporting on this repository, from the Security tab.
Do not open a public issue for it.

The report gets an answer within a week. A fix ships as a patch release, and the changelog names the advisory once the fix is out.

firstlight runs the shell commands a project names in `firstlight.json`, in its `package.json` scripts, or on the command line, and it writes state only under `$XDG_STATE_HOME/firstlight/`. Running those commands is what it is for. A report that shows a check name, a script name, or repository content reaching a file write outside that state directory, a command the project did not name, or a signal to a process firstlight did not start, is in scope.
