The gate of the step `{{step}}` failed on your result more than {{maxGateRuns}} times. Stop fixing it on your own: ask
the people how to go on, as "Questions to the people" says, with `{{relabelQuestion}} --title "❓ RÜCKFRAGE:
<title>"` to mark the issue. Your question names the checks that keep failing and how, what you tried and the options
you see with your recommendation.

## The checks that failed last

{{failures}}

When the answer arrives as your next prompt, run `{{relabelResume}} --title "<title>"`, do what the answer tells you
to, commit, push and write the step result to `.hunt/swf/result.md` again. To give up instead, run `{{relabelFailed}}`
and say why.
