import dotenv from "dotenv";
import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "../aws/awsClients.js";
import { sendEmail } from "../services/emailSenderService.js";
import { renderEmailTemplate } from "../templates/emailTemplateRenderer.js";

dotenv.config();

const queueUrl = process.env.SQS_EMAIL_QUEUE_URL;
const waitTimeSeconds = Number(process.env.SQS_WAIT_TIME_SECONDS ?? 20);
const maxMessages = Number(process.env.SQS_MAX_MESSAGES ?? 5);
const sendDelayMs = Number(process.env.MAIL_SEND_DELAY_MS ?? 250);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!queueUrl) {
    throw new Error("SQS_EMAIL_QUEUE_URL is not configured");
}

const receiveMessages = async () => {
    const command = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
    });

    const response = await sqsClient.send(command);
    return response.Messages ?? [];
};

const deleteMessage = async (receiptHandle) => {
    const command = new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
    });

    await sqsClient.send(command);
};

const processMessage = async (message) => {
    const job = JSON.parse(message.Body);
    const email = renderEmailTemplate(job);
    await sendEmail(email);
    await deleteMessage(message.ReceiptHandle);
    console.log(`Sent email to ${job.to}`);
};

const startWorker = async () => {
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

startWorker();
