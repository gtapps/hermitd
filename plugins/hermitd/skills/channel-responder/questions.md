# Durable questions

A question that outlives this exchange belongs to a task. Send it through the channel reply tool, then block the owning task with `task block .hermit <id> --waiting-on <authority> --status-line '<question>' --next '<what an answer enables>' --decision '<json>'`. The JSON is `{"purpose":"input","authority":"admin|requester|chat","generation":<next-generation>,"options":["label 1","label 2"],"resume":"<existing skill --answer {answer} or named Fix procedure>"}`; omit options for yes/no.

If no task owns the question, use `task open .hermit --title '<question>' --done 'Answer recorded and procedure resumed' --requester <identity> --conversation '<asking-chat>' --waiting-on <authority> --decision '<json>' --dedupe-key 'question:<procedure>:<target>'`. Open creates the wait atomically. Use the ordinary task thread route when a human-requested record requires a thread. Quote every shell argument safely.

Admin decides agent-wide configuration, permission, upgrade and external-content questions. Requester authority applies only to that requester's own input, with the record requester bound to the asking sender. Chat authority applies only to that chat's watch: validate its id and owning chat before creating the decision or resuming its procedure. Never infer narrower authority from free text. Proposal consent is always admin authority.

All replies, even in the original live turn, go through `task answer --chat --user`. Resume only after its match. Keep unanswered questions waiting indefinitely; later does not consume a delivery or cancel the task. Native settings and permission gates remain in force after an answer.
