import dotenv from "dotenv";
import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { fileURLToPath } from "url";
import path from "path";
import { sqsClient } from "../aws/awsClients.js";
import { supabase } from "../SupabaseClient/supabaseClient.js";
import { sendEmail } from "../services/emailSenderService.js";
import { renderEmailTemplate } from "../templates/emailTemplateRenderer.js";

dotenv.config();

const waitTimeSeconds = Number(process.env.SQS_WAIT_TIME_SECONDS ?? 20);
const maxMessages = Number(process.env.SQS_MAX_MESSAGES ?? 5);
const sendDelayMs = Number(process.env.MAIL_SEND_DELAY_MS ?? 250);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const receiveMessages = async () => {
    const queueUrl = process.env.SQS_EMAIL_QUEUE_URL;

    if (!queueUrl) {
        throw new Error("SQS_EMAIL_QUEUE_URL is not configured");
    }

    const command = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
    });

    const response = await sqsClient.send(command);
    return response.Messages ?? [];
};

const deleteMessage = async (receiptHandle) => {
    const queueUrl = process.env.SQS_EMAIL_QUEUE_URL;

    if (!queueUrl) {
        throw new Error("SQS_EMAIL_QUEUE_URL is not configured");
    }

    const command = new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
    });

    await sqsClient.send(command);
};

const canSendCompanyEmail = async (job) => {
    const companyId = job.metadata?.companyId;

    // Email jobs that are not associated with a company keep their existing behavior.
    if (!companyId) return true;

    const { data: company, error } = await supabase
        .from("Companies")
        .select("id, unsubscribed")
        .eq("id", companyId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    // Do not send stale jobs for companies that were removed after queueing.
    if (!company) {
        console.warn(`Skipped email to ${job.to}: company ${companyId} no longer exists`);
        return false;
    }

    if (company.unsubscribed === true) {
        console.log(`Skipped email to ${job.to}: company ${companyId} is unsubscribed`);
        return false;
    }

    return true;
};

const processMessage = async (message) => {
    const job = JSON.parse(message.Body);

    if (!(await canSendCompanyEmail(job))) {
        await deleteMessage(message.ReceiptHandle);
        return;
    }

    const email = renderEmailTemplate(job);
    await sendEmail(email);
    await deleteMessage(message.ReceiptHandle);
    console.log(`Sent email to ${job.to}`);
};

export const startEmailWorker = async () => {
    console.log("Email worker started");

    while (true) {
        try {
            const messages = await receiveMessages();

            for (const message of messages) {
                try {
                    await processMessage(message);
                    await sleep(sendDelayMs);
                } catch (error) {
                    console.error("Email job failed. It will be retried by SQS.", error);
                }
            }
        } catch (error) {
            console.error("Worker polling failed", error);
            await sleep(5000);
        }
    }
};

const isDirectExecution = process.argv[1]
    ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    : false;

if (isDirectExecution) {
    startEmailWorker();
}
