# CoRec

React + Express + MySQL app. Docker Compose runs the web frontend, API, and database together. Register an account with a password, create a group, then share its invite code so others can join. Group members share that group's ledger; other groups cannot access it.

## Run locally with Docker

Copy `.env.example` to `.env`, set unique values for `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD`, then run:

    docker compose up --build -d

Open `http://localhost:8080` (or the port set by `APP_PORT`), register an account, then create a group or join with an invite code. Passwords are hashed before storage, and login sessions use HttpOnly cookies stored in MySQL. MySQL data is stored in the `mysql_data` Docker volume. The database initialization script runs when that volume is first created; the API also applies missing schema changes when it starts.

Set `COOKIE_SECURE=true` when serving the app over HTTPS. Leave it `false` for local HTTP development.

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

Other members must join that CoRec group and complete the same verification with their own accounts. The QQ identity that requests the code must also send the confirmation. Members can unlink their own identity, and the CoRec owner can unlink the entire QQ group. This group identity is separate from the private-chat binding. Group entries are assigned to the sender's CoRec account. Mention the bot on each follow-up, including `确认` and `取消`. The bot refuses entries from unbound senders or anyone who no longer belongs to the ledger, and omits past ledger entries from group replies.

To stop the services while keeping database contents:

    docker compose down

To rebuild after pulling code updates:

    git pull
    docker compose up --build -d

To inspect service logs:

    docker compose logs -f

The API is reachable through the web service's `/api` reverse proxy. MySQL is not published to the host. Back up the `mysql_data` volume before server migrations or maintenance.
