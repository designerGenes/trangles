FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /triangulate .

FROM gcr.io/distroless/static-debian12
COPY --from=build /triangulate /triangulate
# .dockerignore keeps static/*.test.js out of the runtime image; they are
# development assets and would otherwise be served publicly.
COPY static /static
# Tunables and the nickname pool. Without this the binary logs a warning and
# falls back to built-in defaults, which is safe but not what is configured.
COPY config /config
ENV STATIC_DIR=/static
ENV CONFIG_PATH=/config/app.json
EXPOSE 8080
ENTRYPOINT ["/triangulate"]
