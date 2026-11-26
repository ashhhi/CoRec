# CoRec

React + Express + MySQL app. Docker Compose runs the web frontend, API, and database together. Register an account with a password, create a group, then share its invite code so others can apply to join. A group owner or administrator must approve each application before the applicant can access the ledger. Group members share that group's ledger; other groups cannot access it.

## Run locally with Docker

Copy `.env.example` to `.env`, set unique values for `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD`, then run:

    docker compose up --build -d

Open `http://localhost:8080` (or the port set by `APP_PORT`), register an account, then create a group or join with an invite code. Passwords are hashed before storage, and login sessions use HttpOnly cookies stored in MySQL. MySQL data is stored in the `mysql_data` Docker volume. The database initialization script runs when that volume is first created; the API also applies missing schema changes when it starts.

Set `COOKIE_SECURE=true` when serving the app over HTTPS. Leave it `false` for local HTTP development.

## Group membership and permissions

The group panel lists every member's role and QQ private/group binding status. Owners and administrators can copy the invite code, invite an existing CoRec account by username, approve or reject applications, and withdraw invitations. A direct invitation requires the recipient to accept it; an invite code only submits an application. Applicants can view or withdraw their applications, and recipients can accept or decline invitations in the same panel. These lists refresh while the panel is open; approval updates the applicant's available groups automatically.

Only the owner can appoint or remove administrators, transfer ownership, or dissolve the group. Administrators can remove ordinary members; the owner can also remove administrators. Ownership can be transferred to any existing member. The previous owner becomes an ordinary member and can then leave; each group always has one owner. Invite codes are visible only to the owner and administrators.

Owners and administrators can change the group name in the group settings. Names must contain 1–80 characters after trimming surrounding whitespace. Saving refreshes the title and group selector; other members see name updates while their group panel is open.

Ordinary members and administrators can leave a group. Leaving or being removed clears that group's QQ private binding, group identity, and pending binding codes; past ledger entries remain in the group. Dissolving a group permanently deletes its ledger entries, membership, QQ bindings, applications, and invitations. The website asks for confirmation before removing members, changing administrators, transferring ownership, leaving, or dissolving a group. The API applies the role migration and creates the application/invitation tables automatically on startup.

To run the group integration tests, use a separate MySQL 8 instance and set `COREC_TEST_MYSQL_URL` to its connection URL, then run `npm run test:groups`. The test account needs permission to create and drop databases. Each run creates a randomly named test database and removes it afterward. The tests cover approvals, invitations, role restrictions, concurrent ownership transfers, QQ cleanup, and dissolution. Without a test database connection, the suite is skipped.

## Tasks and scheduled reminders

The **任务** page stores shared tasks, assignees, due times, execution results, and notification status. Members can create tasks; the creator, assignee, owner, or administrator can complete, cancel, reschedule, or retry their notifications. Unscheduled reminders are simple to-do items. All task times use Hong Kong time (UTC+8).

In web Chat, say `明天下午3点提醒我交水电费，在群里提醒` and confirm the task draft. In QQ, mention the bot with the same request; a complete task is saved immediately and the bot returns its number. Missing dates or times trigger a follow-up question. Say `完成任务 123` or `取消任务 123` to update a specific task. Follow-ups without mentioning the bot still require QQ to deliver ordinary group messages.

Three task types are supported: reminders wait for a person to confirm completion; scheduled text generation produces a plan, list, or other text; ledger summaries report the current group's income and expenses from the first of the execution month through the execution date. Automatic tasks are marked complete only after a result is produced. External actions such as purchases, booking, sending email, or looking up live weather are not supported. Recurring schedules are not supported yet; schedule a single date and time.

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
