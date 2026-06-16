import { SendEmailCommand } from "@aws-sdk/client-ses";
import { sesClient } from "../aws/awsClients.js";

const getSenderEmail = () => {
    if (!process.env.SES_FROM_EMAIL) {
        throw new Error("SES_FROM_EMAIL is not configured");
    }

    return process.env.SES_FROM_EMAIL;
};

export const sendEmail = async ({ to, subject, text, html }) => {
    const command = new SendEmailCommand({
        Source: getSenderEmail(),
        Destination: {
            ToAddresses: Array.isArray(to) ? to : [to],
        },
        Message: {
            Subject: {
                Data: subject,
                Charset: "UTF-8",
            },
            Body: {
                ...(text
                    ? {
                        Text: {
                            Data: text,
                            Charset: "UTF-8",
                        },
                    }
                    : {}),
                ...(html
                    ? {
                        Html: {
                            Data: html,
                            Charset: "UTF-8",
                        },
                    }
                    : {}),
            },
        },
    });

    return sesClient.send(command);
};
