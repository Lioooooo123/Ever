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
	delete sanitized.EVER_EVAL_EFFECT_GATE_DIR;
	delete sanitized.EVER_EVAL_EFFECT_GATE_EFFECT;
	delete sanitized.EVER_EVAL_EFFECT_GATE_SECRET;
	delete sanitized.EVER_EVAL_EFFECT_GATE_TOOL_NAME;
	delete sanitized.EVER_EVAL_EFFECT_GATE_TARGET_PATH;
	delete sanitized.EVER_EVAL_EFFECT_GATE_COMMAND_INCLUDES;
	delete sanitized.EVER_EVAL_EFFECT_GATE_DOMAIN_COMMIT_ID;
	delete sanitized.EVER_EVAL_EFFECT_GATE_EVIDENCE_PATH;
	delete sanitized.EVER_EVAL_EFFECT_GATE_EVIDENCE_INCLUDES;
	delete sanitized.EVER_EVAL_EFFECT_GATE_EXPECTED_TOOL_ERROR;
	return sanitized;
}
