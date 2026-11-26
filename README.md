# CoRec

React + Express + MySQL app. Docker Compose runs the web frontend, API, and database together. Register an account with a password, create a group, then share its invite code so others can apply to join. A group owner or administrator must approve each application before the applicant can access the ledger. Group members share that group's ledger; other groups cannot access it.

## Run with Docker

Copy `.env.example` to `.env` and set unique values for `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD`. Docker Compose now includes HTTPS in its main configuration and publishes ports 80 and 443. For the first deployment on Ubuntu with a fixed public IP and no domain, follow [the IP certificate deployment guide](deploy/HTTPS.md) to obtain a certificate and enable automatic renewal.

Once the certificate is installed, start or update the app with:

    docker compose up --build -d

Open `https://YOUR_PUBLIC_IP`, register an account, then create a group or join with an invite code. Passwords are hashed before storage, and login sessions use HttpOnly cookies stored in MySQL. MySQL data is stored in the `mysql_data` Docker volume. The database initialization script runs when that volume is first created; the API also applies missing schema changes when it starts.

Keep `COOKIE_SECURE=true` in `.env` when serving the app over HTTPS. If upgrading an existing deployment, change its old `COOKIE_SECURE=false` setting to `true`. The old `APP_PORT` setting is no longer used; a second Compose file is no longer needed.

For local HTTP development, select the HTTP configuration and disable secure cookies for that invocation:

    COREC_NGINX_CONFIG=./deploy/nginx.conf COOKIE_SECURE=false docker compose up --build -d

Then open `http://localhost`. Use the same environment overrides for subsequent local HTTP updates. Production HTTPS redirects HTTP requests automatically, and certificate renewal reloads Nginx without restarting the container.

## Group membership and permissions

The group panel lists every member's role and QQ private/group binding status. Owners and administrators can copy the invite code, invite an existing CoRec account by username, approve or reject applications, and withdraw invitations. A direct invitation requires the recipient to accept it; an invite code only submits an application. Applicants can view or withdraw their applications, and recipients can accept or decline invitations in the same panel. These lists refresh while the panel is open; approval updates the applicant's available groups automatically.

Only the owner can appoint or remove administrators, transfer ownership, or dissolve the group. Administrators can remove ordinary members; the owner can also remove administrators. Ownership can be transferred to any existing member. The previous owner becomes an ordinary member and can then leave; each group always has one owner. Invite codes are visible only to the owner and administrators.

Owners and administrators can change the group name in the group settings. Names must contain 1–80 characters after trimming surrounding whitespace. Saving refreshes the title and group selector; other members see name updates while their group panel is open.

Ordinary members and administrators can leave a group. Leaving or being removed clears that group's QQ private binding, group identity, and pending binding codes; past ledger entries remain in the group. Dissolving a group permanently deletes its ledger entries, membership, QQ bindings, applications, and invitations. The website asks for confirmation before removing members, changing administrators, transferring ownership, leaving, or dissolving a group. The API applies the role migration and creates the application/invitation tables automatically on startup.

To run the group integration tests, use a separate MySQL 8 instance and set `COREC_TEST_MYSQL_URL` to its connection URL, then run `npm run test:groups`. The test account needs permission to create and drop databases. Each run creates a randomly named test database and removes it afterward. The tests cover approvals, invitations, role restrictions, concurrent ownership transfers, QQ cleanup, and dissolution. Without a test database connection, the suite is skipped.

## Savings and account transfers

The balance strip shows the active account balance and a separate gray savings balance with a lock icon. Existing income and expenses belong to the active account. **存款 / 转账** records a move from the active account to savings or from savings back to the active account, using category **存款**. Savings starts at zero and equals income allocated to savings plus deposits minus withdrawals; the active balance equals all income minus expenses minus the net increase in savings. Transfers appear in the ledger and calendar's daily records, but are excluded from income/expense totals, charts, and scheduled ledger summaries.

Choose the transfer direction in the new-entry form, or tell Chat/QQ `今天存入存款500元` or `今天从存款取出200元到活动账户`. These are accounting records only. A withdrawal cannot exceed the recorded savings balance; deleting a deposit is blocked if it would make savings negative. Account balances are shared by the ledger, across all months. Resetting the ledger also removes its transfers and returns both balances to zero. Existing data is preserved, and the API adds the transfer type and direction column at startup.

Income can go directly to savings or be split between accounts. In the income form, enter the total income and the amount to put into savings; the remainder goes to the active account. Chat and QQ support `今天收入3000，存入存款1000元` (active +2000, savings +1000, total income 3000) and `今天工资3000全部存入存款` (active unchanged, savings +3000). This remains one income record and does not create an additional transfer. Unspecified destinations default to the active account. Deleting income allocated to savings is blocked if it would leave savings negative. Existing income retains its original active-account allocation; the API automatically adds the allocation column at startup.

One message or image can contain up to 50 ledger entries. Chat shows each entry and its member/account allocation, then confirms the batch; image entries are saved automatically when complete. QQ saves complete batches and returns their summaries. Missing information prompts a follow-up. All entries are validated and saved in one transaction, so an error or duplicate confirmation leaves the entire batch unsaved. A receipt's total and line items are not counted twice: by default one receipt is one transaction, unless the user explicitly requests a breakdown by item.

Ledger dates and times use Hong Kong time (UTC+8). In Chat and QQ, an unspecified date defaults to today and an unspecified time defaults to the current hour and minute: a message such as `午饭花了35元` is recorded as happening now. If a message supplies a date such as today, yesterday, or a weekday without a specific time, that date is kept and the current hour and minute are filled. Explicit times from text or receipts are preserved. The API also fills missing times for new records; existing records are unchanged. Reminder tasks still require an explicit execution time.

Existing records can be edited from their ledger details or the calendar’s daily records. Ordinary members may edit only records attributed to themselves and cannot reassign them; owners and administrators may edit any record in their group. The API checks the current role inside the update transaction, excludes the edited record from duplicate checks, and rejects changes that would leave savings negative. Changes refresh balances, the calendar, and analytics.

## Operation history

The **操作记录** tab follows **Chat**. It lists the current group's actions with the actor's name at the time, Hong Kong time, source (web, Chat, QQ private/group, or system), outcome and expandable details. The current group owner can filter by actor, category and date and load older entries in pages of 50. Only the current group owner can see this tab or read its API, including the personal-history view; administrators and ordinary members cannot. Page visits and data changes from all members continue to be recorded. Ownership transfer also transfers access to this tab. **我的全部操作** additionally shows that user's own account actions and actions in former/dissolved groups; other users' personal account history is not shared.

History covers each created/edited/deleted ledger record (including batches and income allocation), ledger resets, group creation/renaming, applications/approvals/invitations, role changes, ownership transfers, member removals/exits, group dissolution, QQ binding, task creation/completion/cancellation/rescheduling/retries, scheduled execution/notification results, Chat requests, cancelled drafts, cleared conversations and page visits. Core ledger/group/task changes and their snapshots are written in the same database transaction. Other authenticated mutation outcomes are appended by a request completion handler; failures to append those supplemental records are reported in the server log. Automated polling is excluded. Passwords, tokens, invitation/binding codes, QQ identifiers, model settings, raw chat content and image payloads are excluded from snapshots.

The API creates `audit_logs` automatically at startup. Recording starts after deployment; earlier operations cannot be reconstructed. The history has no edit/delete endpoint and survives ledger resets, member removal and group dissolution. Entries for a dissolved group remain accessible to their respective actors through their personal history when they have a group available in the UI. This release adds no automatic history expiration.

## Tasks and scheduled reminders

The **任务** page stores shared tasks, assignees, due times, execution results, and notification status. Members can create tasks; the creator, assignee, owner, or administrator can complete, cancel, reschedule, or retry their notifications. Unscheduled reminders are simple to-do items. All task times use Hong Kong time (UTC+8).

In web Chat, say `明天下午3点提醒我交水电费，在群里提醒` and confirm the task draft. In QQ, mention the bot with the same request; a complete task is saved immediately and the bot returns its number. Missing dates or times trigger a follow-up question. Say `完成任务 123` or `取消任务 123` to update a specific task. Follow-ups without mentioning the bot still require QQ to deliver ordinary group messages.

Three task types are supported: reminders wait for a person to confirm completion; scheduled text generation produces a plan, list, or other text; ledger summaries report the current group's income and expenses from the first of the execution month through the execution date. Automatic tasks are marked complete only after a result is produced. External actions such as purchases, booking, sending email, or looking up live weather are not supported.

Tasks can repeat every N minutes, hours, or days, on selected weekdays, or on selected days of the month. For example: `每天7点45叫我起床`, `每隔3天提醒我浇花`, `每周一、五下午3点提醒我开会`, `每月1号上午9点提醒我交房租`, or `每隔30分钟提醒我喝水`. The task editor supports the same rules. The minimum interval is one minute. Calendar rules use Hong Kong time; monthly dates that do not exist are skipped. The API upgrades existing task tables automatically.

A recurring plan shows its next execution time, and each occurrence gets a separate task number with its own completion and delivery status. Completing an occurrence does not stop the plan. Use **停止重复计划** or `取消任务 <计划编号>` to stop future work and pending occurrences. After downtime, one overdue occurrence is processed and the schedule advances to the next future time rather than sending every missed reminder. Short task instructions such as `每天…叫我…` also trigger QQ task recognition when ordinary group messages are delivered; task follow-up errors now receive a reply instead of being silently discarded.

Notifications default to the QQ group linked to the current ledger. A private notification requires the assignee's QQ private binding to the same ledger. Configure `QQ_BOT_APP_ID` and `QQ_BOT_CLIENT_SECRET`: Compose passes them to both the API and bot. The API handles scheduling while the `qqbot` profile receives QQ conversations and completion replies. The API must stay running; it checks roughly every 10 seconds and processes overdue work after restarting. Long queues can delay notifications.

Scheduled notifications use QQ's proactive messaging API, without reusing a past `msg_id`. QQ can reject them when permissions, rate limits, or the recipient's **允许主动发送** setting prevent delivery. See the [official QQ messaging overview](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html). The task page shows delivery separately from completion, retries failed sends up to three times, and allows a manual retry. Changing a QQ binding or leaving the group stops delivery; an explicit retry/reschedule is needed to use a new binding. Worker claims survive restarts, but a crash after QQ accepts a message and before the database records delivery can result in a duplicate notification. Long results remain fully available on the task page, with a shortened QQ message.

The API creates the task table automatically on startup. Run `npm run test:tasks` with `COREC_TEST_MYSQL_URL` pointing to a separate test MySQL instance to exercise scheduling, completion, retries, permissions, and restart recovery. QQ sends and text generation are mocked in tests; no real notifications are sent.

## Chat model setup

Configure the server-side model in `.env`. The default values below match the LingSuan setup shown in the Chat page:

    LLM_BASE_URL=https://edge.lingsuan.org
    LLM_API_KEY=your-provider-api-key
    LLM_MODEL=gpt-6-luna
    LLM_API_FORMAT=responses

`LLM_API_FORMAT` accepts `responses` or `chat-completions`. Restart the API after changing `.env`:

    docker compose up --build -d

The browser stores chat history only. Model requests are relayed through the authenticated CoRec API, and the API key is read from the API container environment rather than sent by the browser or stored in the database. Image-based entries are saved automatically when their required details are known; possible duplicates require confirmation. Text-based entries are saved after a group member confirms the draft.

Chat supports one JPEG, PNG, WebP, or GIF image per message, up to 4 MB. The configured model and provider must support image input. Images remain in the current page session and are not saved in chat history; after a refresh, they must be uploaded again for the model to see them. If another reverse proxy is placed in front of CoRec, configure it to accept request bodies of at least 6 MB.

## QQ Private Chat Bot

The optional `qqbot` service connects to the official QQ Bot WebSocket gateway and handles private messages. Register a bot in the QQ Open Platform, enable the bot's private-chat event and messaging permissions, and configure the platform to use WebSocket event delivery. QQ platform availability and bot approval are subject to its current rules.

Set these values in `.env` (keep the app secret and internal token private):

    QQ_BOT_APP_ID=your-app-id
    QQ_BOT_CLIENT_SECRET=your-client-secret
    QQ_BOT_INTERNAL_TOKEN=a-unique-random-secret-at-least-32-characters
    TZ=Asia/Shanghai

Generate a distinct internal token with `openssl rand -hex 32`. The API and bot receive the same token from `.env`; it grants the bot access to the internal accounting endpoints, so do not reuse a database password or share it. Configure the existing `LLM_*` values as well. The model must support image input to process QQ pictures.

Start the bot alongside CoRec:

    docker compose --profile qqbot up -d --build
    docker compose --profile qqbot logs -f qqbot

Log in to CoRec, select the desired group, open the group panel, and generate a QQ binding code. Send the bot `绑定 <code>` in a private chat within 10 minutes. A code works once; generating another invalidates the previous code. Each CoRec account can bind one QQ identity and one active group, and binding again replaces its existing mapping. You can remove the binding from the same group panel.

Send a text message or one image to record an entry. The bot asks for missing details and saves complete entries. When another entry in the same group has the same date, type and amount, the bot lists possible duplicates and waits for `确认` or `取消`. Send `重新开始` to discard an unfinished conversation. QQ may deliver the same event more than once; processed message IDs are stored to prevent repeat processing. The bot stores unfinished conversation context, including its latest image, in MySQL for up to 24 hours; processed event hashes are retained for up to seven days. Completed conversations are cleared.

For QQ group chat, enable group @ message access for the bot in QQ Open Platform and add the bot to the QQ group. The CoRec group owner first mentions the bot and sends `绑定` in that chat. In the CoRec group panel, enter the returned request code under **QQ 群聊绑定**, then mention the bot again in the same chat and send `确认绑定 <code>` with the code displayed on the website. The request expires after 10 minutes. Each QQ group links to one CoRec ledger, and each ledger links to one QQ group.

Other members must join that CoRec group and complete the same verification with their own accounts. The QQ identity that requests the code must also send the confirmation. Members can unlink their own identity, and the CoRec owner can unlink the entire QQ group. This group identity is separate from the private-chat binding. Group entries are assigned to the sender's CoRec account. The bot refuses entries from unbound senders or anyone who no longer belongs to the ledger, and omits past ledger entries from group replies.

To use the bot without mentioning it, the QQ group owner can open the bot's settings in the mobile QQ group and set **机器人可获取的群聊消息范围** to **获取群内全部消息**. For bound members, ordinary messages trigger receipt recognition when they include a money word or amount, a quantity such as `两杯`, or an image. After the bot asks for missing details, the same sender can continue in natural language without another mention for 10 minutes after each question, for example `今天，娱乐` or `是今天出去玩的`. Follow-up text is checked against that sender's unfinished conversation in the same QQ group; unrelated chat is ignored, and saving or canceling clears the conversation. A bound member can also send `记账 今天午饭花了 35 元` or use `记账` followed by the requested details. For possible duplicates, the sender can use `确认入账` or `取消入账`, or simply `确认` or `取消` within 10 minutes of the duplicate prompt. The bot logs `QQ full group message event received.` when it first receives a full group message event after connecting. Starting a conversation with a mention does not grant access to later unmentioned messages: when the group only delivers mentions, mention the bot on each follow-up.

To stop the services while keeping database contents:

    docker compose down

To rebuild after pulling code updates:

    git pull
    docker compose up --build -d

To inspect service logs:

    docker compose logs -f

The API is reachable through the web service's `/api` reverse proxy. MySQL is not published to the host. Back up the `mysql_data` volume before server migrations or maintenance.
