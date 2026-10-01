import { buildQuotationRequestEmail } from "./quotationRequestTemplate.js";
import { buildPlainMessageEmail } from "./plainMessageTemplate.js";

export const renderEmailTemplate = (job) => {
    if (!job.template) {
        return job;
    }

    if (job.template === "quotationRequest") {
        const rendered = buildQuotationRequestEmail(job.templateData ?? {});
        return {
            ...job,
            subject: job.subject ?? rendered.subject,
            text: job.text ?? rendered.text,
            html: job.html ?? rendered.html,
        };
    }

    if (job.template === "plainMessage") {
        const rendered = buildPlainMessageEmail(job.templateData ?? {});
        return {
            ...job,
            subject: job.subject ?? rendered.subject,
            text: job.text ?? rendered.text,
            html: job.html ?? rendered.html,
        };
    }

    throw new Error(`Unknown email template: ${job.template}`);
};
