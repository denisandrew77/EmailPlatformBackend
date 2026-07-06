import dotenv from "dotenv";
import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "../aws/awsClients.js";
import { supabase } from "../SupabaseClient/supabaseClient.js";

dotenv.config();

const waitTimeSeconds = Number(process.env.SQS_FEEDBACK_WAIT_TIME_SECONDS ?? process.env.SQS_WAIT_TIME_SECONDS ?? 20);
const maxMessages = Number(process.env.SQS_FEEDBACK_MAX_MESSAGES ?? process.env.SQS_MAX_MESSAGES ?? 5);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getFeedbackQueueUrl = () => {
    if (!process.env.SQS_EMAIL_FEEDBACK_QUEUE_URL) {
        throw new Error("SQS_EMAIL_FEEDBACK_QUEUE_URL is not configured");
    }

    return process.env.SQS_EMAIL_FEEDBACK_QUEUE_URL;
};

const receiveMessages = async () => {
    const command = new ReceiveMessageCommand({
        QueueUrl: getFeedbackQueueUrl(),
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
    });

    const response = await sqsClient.send(command);
    return response.Messages ?? [];
};

const deleteMessage = async (receiptHandle) => {
    const command = new DeleteMessageCommand({
        QueueUrl: getFeedbackQueueUrl(),
        ReceiptHandle: receiptHandle,
    });

    await sqsClient.send(command);
};

const parseJson = (value) => {
    if (!value) return null;

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const parseSesNotification = (body) => {
    const sqsMessage = parseJson(body);
    if (!sqsMessage) return null;

    if (sqsMessage.Type === "Notification" && sqsMessage.Message) {
        return parseJson(sqsMessage.Message);
    }

    return sqsMessage;
};

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

const getFeedbackEmails = (notification) => {
    const type = notification?.notificationType;

    if (type === "Bounce") {
        return (notification.bounce?.bouncedRecipients ?? [])
            .map((recipient) => normalizeEmail(recipient.emailAddress))
            .filter(Boolean);
    }

    if (type === "Complaint") {
        return (notification.complaint?.complainedRecipients ?? [])
            .map((recipient) => normalizeEmail(recipient.emailAddress))
            .filter(Boolean);
    }

    return [];
};

const getSuppressionReason = (notification) => {
    if (notification?.notificationType === "Complaint") {
        return "Complaint";
    }

    if (
        notification?.notificationType === "Bounce" &&
        notification.bounce?.bounceType === "Permanent"
    ) {
        return "Permanent bounce";
    }

    return null;
};

const suppressCompanyEmails = async (emails, feedbackType) => {
    if (!emails.length) return 0;

    const matchingCompanies = [];

    for (const email of emails) {
        const { data: companies, error: selectError } = await supabase
            .from("Companies")
            .select("id, emailAddress")
            .ilike("emailAddress", email);

        if (selectError) {
            throw selectError;
        }

        matchingCompanies.push(...(companies ?? []));
    }

    const companyIds = [...new Set(matchingCompanies.map((company) => company.id))];
    if (!companyIds.length) {
        console.warn(`SES ${feedbackType}: no matching companies found for ${emails.join(", ")}`);
        return 0;
    }

    const { error: updateError } = await supabase
        .from("Companies")
        .update({ unsubscribed: true })
        .in("id", companyIds);

    if (updateError) {
        throw updateError;
    }

    console.log(`SES ${feedbackType}: marked ${companyIds.length} company email(s) as unsubscribed: ${emails.join(", ")}`);
    return companyIds.length;
};

const processMessage = async (message) => {
    const notification = parseSesNotification(message.Body);
    const feedbackType = notification?.notificationType;

    if (!["Bounce", "Complaint"].includes(feedbackType)) {
        console.log(`Ignored SES feedback message type: ${feedbackType ?? "unknown"}`);
        await deleteMessage(message.ReceiptHandle);
        return;
    }

    const emails = getFeedbackEmails(notification);
    const suppressionReason = getSuppressionReason(notification);

    if (!suppressionReason) {
        const bounceType = notification.bounce?.bounceType ?? "Unknown";
        const bounceSubType = notification.bounce?.bounceSubType ?? "Unknown";

        console.info(
            `SES ${bounceType}/${bounceSubType} bounce recorded without suppression for: ${emails.join(", ") || "unknown recipient"}`
        );
        await deleteMessage(message.ReceiptHandle);
        return;
    }

    await suppressCompanyEmails(emails, suppressionReason);
    await deleteMessage(message.ReceiptHandle);
};

export const startEmailFeedbackWorker = async () => {
    console.log("Email feedback worker started");

    while (true) {
        try {
            const messages = await receiveMessages();

            for (const message of messages) {
                try {
                    await processMessage(message);
                } catch (error) {
                    console.error("Email feedback message failed. It will be retried by SQS.", error);
                }
            }
        } catch (error) {
            console.error("Feedback worker polling failed", error);
            await sleep(5000);
        }
    }
};

if (import.meta.url === `file://${process.argv[1]}`) {
    startEmailFeedbackWorker();
}
