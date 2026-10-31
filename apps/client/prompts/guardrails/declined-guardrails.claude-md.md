## Declined guardrail suggestions

`{{declinesFile}}` lists every guardrail suggestion the user declined in this repository, one JSON
object per line with `kind`, `reason` (`tooSpecific`, `alreadyRecorded` or `notWanted`), `summary` and `declinedAt`;
Hunt appends a line whenever the user declines a suggestion. Before you suggest a guardrail, search the file with
`grep -i` for a few key words of your suggestion and look at the last `tooSpecific` lines as examples of what is too
narrow; never read the whole file. Suggest nothing that a declined entry already covers or that is as narrow as one.
