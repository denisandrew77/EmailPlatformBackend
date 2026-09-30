# SMTP2GO setup

Put these settings in `EmailApp-Backend/.env` locally, and in the backend/worker
environment variables on your hosting platform. Never put the API key in the frontend.

```dotenv
SMTP2GO_API_KEY=your-api-key
SMTP2GO_FROM_EMAIL=your-verified-sender@example.com
SMTP2GO_FROM_NAME=ByExpress
SMTP2GO_WEBHOOK_SECRET=your-separate-random-secret
```

The sender or its domain must be verified in SMTP2GO, and the API key must allow
`/email/send`. Start the API and worker from the backend directory so dotenv finds
`.env`. Restart both after changing their environment variables. Node 20+ is required.

AWS SQS still queues jobs: keep your AWS credentials, region and
`SQS_EMAIL_QUEUE_URL`. Run `npm run worker:email`, or set
`RUN_EMAIL_WORKER_IN_API=true` to run the worker inside the API process.
Remove the old `SES_FROM_EMAIL` and `SES_FROM_NAME` variables once the new sender is set.

## Feedback

In SMTP2GO Settings > Webhooks, add a webhook for your sending API key:

- URL: `https://your-backend-host/api/v1/webhooks/smtp2go`
- Output: JSON
- Authorization: Bearer, with the value of `SMTP2GO_WEBHOOK_SECRET`
- Events: bounce, spam, unsubscribe

The secret is separate from the SMTP2GO API key. Generate one with
`openssl rand -hex 32` and use the same value in both places.

Hard bounces, spam complaints and provider unsubscribes mark matching Companies
as unsubscribed, which also stops pending company jobs. Soft bounces do not.
The app's existing unsubscribe links still work and send the internal notification
to `SMTP2GO_FROM_EMAIL`.

The API no longer starts the legacy SES feedback worker. Its standalone script is
retained only to drain old SES feedback if needed; stop that process after migration.
`RUN_EMAIL_FEEDBACK_WORKER_IN_API` is no longer used.

Sending checks HTTP status and recipient acceptance counts, because SMTP2GO can
report failures with HTTP 200. Failed sends remain subject to the existing SQS retry
policy. Configure a queue dead-letter policy for persistent failures. As with SES,
SQS processing is at least once: ambiguous network failures and partially accepted
multi-recipient sends can cause duplicates on retry. Campaign jobs use one recipient.

Run adapter and webhook checks without sending mail: `node --test tests/*.test.js`.

References:
- https://developers.smtp2go.com/reference/send-standard-email
- https://developers.smtp2go.com/docs/setup-a-webhook
- https://developers.smtp2go.com/docs/webhooks-overview
