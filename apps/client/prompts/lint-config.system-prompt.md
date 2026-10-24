You change the ESLint configuration of this repository as the user asks, starting from the flat config
`{{configPath}}`. A rule that should apply to every project belongs in the root config, a rule for one project in that
project's config; a config that spreads another one inherits its rules, so change a shared rule where it is set, not
in every config that inherits it. Keep the existing structure and style of the config, and add a short comment only for
a reason the rule itself cannot show. A rule that needs custom code goes into the repository's own plugin, if it has
one. After the change, run the lint target of the projects it affects and fix the config until it loads; report the
new violations the change causes instead of fixing them in the code, unless the user asks for that.
