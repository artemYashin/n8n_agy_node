# Telegram AI Agent: generate and send an image

Import these two workflows through **Import from File**. They contain no credentials and are inactive until you configure them.

## 1. Import `telegram-image-tool.json` first

This sub-workflow implements:

`Image Tool Input → Validate Input → Generate Image → Convert Image to File → Send Photo → Delivery Status`

Configure:

1. **Generate Image → URL**: your Agy server, e.g. `http://192.168.1.100:44455/v1/images/generations`.
2. **Generate Image → credential**: create/select **Header Auth** with name `Authorization` and value `Bearer YOUR_AGY_API_KEY`. This is the Docker API key, not Google credentials.
3. **Send Photo → credential**: your Telegram bot credential.
4. Save the workflow (publish it if your n8n version requires published sub-workflows).

The HTTP timeout is 300 seconds, slightly longer than the server's default 240-second image timeout. Do not enable automatic retries: retrying can generate or send a second image. A failed Telegram upload does not mean image generation failed; inspect the sub-workflow execution before retrying.

The response's `data[0].b64_json` becomes binary `data`, using the actual `mime_type` and `file_name` returned by our server. Base64 and binary data do not return to the AI Agent. The last Code node returns `sent: true` and Telegram's message ID only after Telegram confirms delivery. Failures stop the sub-workflow.

## 2. Import `telegram-image-agent.json`

Configure:

1. Select the same Telegram bot credential on **Telegram Trigger** and **Send Reply**.
2. **OpenAI Chat Model → credential**: your Docker API key and Base URL `http://YOUR_SERVER:44455/v1`. Select an available text model (example uses `gemini-3.8-flash-medium`). **Use Responses API must stay OFF**. Leave temperature/max tokens unset.
3. **generate_and_send_image → Workflow**: replace the placeholder by selecting the saved image sub-workflow. Refresh workflow inputs if n8n requests it.
4. Confirm the tool input mappings:
   - `prompt`: `{{ $fromAI('prompt', 'Detailed visual description of the image the user wants to generate', 'string') }}`
   - `chat_id`: `{{ String($('Telegram Trigger').first().json.message.chat.id) }}`
5. Save and activate/publish the main workflow. Telegram Trigger requires your n8n installation's externally reachable HTTPS webhook URL.

The agent receives the user's Telegram message and can decide to invoke the tool. The example's **workflow-level** system prompt describes the tool and tells the agent not to resend images. You can edit it; the Docker chat API still adds no default system prompt.

The tool's recipient and API URL are configured in the workflow, not supplied by the AI. Keep those mappings. Use the same bot for the trigger and photo delivery; a Telegram bot cannot initiate a private conversation with a user who has not started it.

## 3. Test

Send your bot: `Draw a watercolor of a small orange sailboat on an alpine lake.`

Expected: the sub-workflow sends a photo, then the agent sends a short text confirmation. Normal text requests can be answered without invoking the image tool.

Troubleshooting:

- `account_verification_required`: complete Google verification on the Agy setup page and retry.
- `image_quota_exceeded` / `image_rate_limit_exceeded`: wait for the returned `retry_after_seconds` / `Retry-After` before retrying. Text models can still work when image quota is exhausted.
- `image_not_generated`: Agy returned no valid image; no photo is sent.
- `Unknown endpoint`: update/rebuild the Docker app; image generation requires this version.
- Workflow not found: select the imported sub-workflow instead of `SELECT_IMAGE_WORKFLOW`.
- Telegram error: check bot credentials and trigger chat ID. The agent must not claim success if photo delivery failed.
- If n8n runs in Docker, use an address reachable from its container; `localhost` means that container itself.

The JSON schemas are checked against n8n's node source, and local tests cover expressions and delivery-status handling. Actual import and Telegram delivery require your n8n instance and bot credentials; they are not executed by the repository tests.
