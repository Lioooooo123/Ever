FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944
WORKDIR /app
COPY app/ /app/
RUN adduser -D agent && mkdir -p /logs/verifier && chown -R agent:agent /app /logs
USER agent
CMD ["sh"]
