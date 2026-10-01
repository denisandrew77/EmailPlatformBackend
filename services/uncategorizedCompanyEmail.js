const hasCategory = (company) => (
    company.threeTonnCategory === true
    || company.sevenTonnCategory === true
    || company.caddyCategory === true
);

export const normalizeUncategorizedCompanyMessage = (value) => {
    const message = String(value ?? "").trim();
    if (!message || message.length > 10000) {
        throw new Error("Message must contain between 1 and 10000 characters");
    }
    return message;
};

export const buildUncategorizedCompanyEmailJobs = (companies, message, createUnsubscribeUrl) => (
    (companies ?? [])
        .filter((company) => (
            company.emailAddress
            && company.unsubscribed !== true
            && !hasCategory(company)
        ))
        .map((company) => ({
            to: company.emailAddress,
            template: "plainMessage",
            templateData: {
                message,
                unsubscribeUrl: createUnsubscribeUrl(company),
            },
            metadata: {
                companyId: company.id,
                companyName: company.name,
                campaignType: "uncategorized-companies",
            },
        }))
);
