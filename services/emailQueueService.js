import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "../aws/awsClients.js";

const getQueueUrl = () => {
    if (!process.env.SQS_EMAIL_QUEUE_URL) {
        throw new Error("SQS_EMAIL_QUEUE_URL is not configured");
    }

    return process.env.SQS_EMAIL_QUEUE_URL;
};

export const enqueueEmailJob = async ({ to, subject, text, html, template, templateData, metadata = {} }) => {
    if (!to || (!subject && !template) || (!text && !html && !template)) {
        throw new Error("Email job requires to and either raw email content or a template");
    }

    const command = new SendMessageCommand({
        QueueUrl: getQueueUrl(),
        MessageBody: JSON.stringify({
            to,
            subject,
            text,
            html,
            template,
            templateData,
            metadata,
            queuedAt: new Date().toISOString(),
        }),
    });

    const result = await sqsClient.send(command);
    return result.MessageId;
};

export const enqueueEmailJobs = async (jobs) => {
    const results = [];

    for (const job of jobs) {
        const messageId = await enqueueEmailJob(job);
        results.push({ to: job.to, messageId });
    }

    return results;
};
