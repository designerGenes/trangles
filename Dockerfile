FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /triangulate .

FROM gcr.io/distroless/static-debian12
COPY --from=build /triangulate /triangulate
COPY static /static
ENV STATIC_DIR=/static
EXPOSE 8080
ENTRYPOINT ["/triangulate"]
