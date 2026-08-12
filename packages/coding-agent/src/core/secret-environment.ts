const SECRET_ENV_NAME =
	/(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|TOKEN|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SECRET|PASSWORD|CREDENTIALS?)$/i;

/** Remove ambient credentials and host credential capabilities from an unattended process environment. */
export function sanitizeUnattendedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const sanitized = { ...environment };
	for (const name of Object.keys(sanitized)) {
		if (SECRET_ENV_NAME.test(name)) delete sanitized[name];
	}
	delete sanitized.SSH_AUTH_SOCK;
	delete sanitized.GPG_AGENT_INFO;
	delete sanitized.GOOGLE_APPLICATION_CREDENTIALS;
	return sanitized;
}
