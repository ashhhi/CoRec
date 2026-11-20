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

To stop the services while keeping database contents:

    docker compose down

To rebuild after pulling code updates:

    git pull
    docker compose up --build -d

To inspect service logs:

    docker compose logs -f

The API is reachable through the web service's `/api` reverse proxy. MySQL is not published to the host. Back up the `mysql_data` volume before server migrations or maintenance.
