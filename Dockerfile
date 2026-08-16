FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /trangles .

FROM gcr.io/distroless/static-debian12
COPY --from=build /trangles /trangles
# .dockerignore keeps static/*.test.js out of the runtime image; they are
# development assets and would otherwise be served publicly.
COPY static /static
# devtools/ is deliberately absent: the colour lab is a local development tool
# that writes to style.css, and the runtime image has no business carrying it.
# Client-side strings the browser fetches from /resources/strings.json.
COPY resources /resources
# Tunables and the nickname pool. Without this the binary logs a warning and
# falls back to built-in defaults, which is safe but not what is configured.
COPY config /config
ENV STATIC_DIR=/static
ENV RESOURCES_DIR=/resources
ENV CONFIG_PATH=/config/app.json
EXPOSE 8080
ENTRYPOINT ["/trangles"]
