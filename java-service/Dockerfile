# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM maven:3.9-eclipse-temurin-17 AS builder

WORKDIR /build

RUN apt-get update -y; apt-get install curl -y

# Add the datadog tracing library to the container
RUN curl -Lo dd-java-agent.jar 'https://dtdg.co/latest-java-tracer'

# Copy dependency descriptors first to leverage Docker layer cache
COPY pom.xml .
RUN mvn dependency:go-offline -B --no-transfer-progress

# Copy source and build the JAR
COPY src ./src
RUN mvn package -DskipTests -B --no-transfer-progress

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM eclipse-temurin:17-jre AS runtime

WORKDIR /app

# Create a non-root user for security
RUN groupadd -r appgroup && useradd -r -g appgroup appuser

# Copy the  JAR produced by the build stage
COPY --from=builder /build/target/*.jar app.jar
COPY --from=builder /build/dd-java-agent.jar dd-java-agent.jar

# Set ownership
RUN chown appuser:appgroup app.jar dd-java-agent.jar

USER appuser

EXPOSE 8081

ENTRYPOINT ["java", "-javaagent:dd-java-agent.jar", "-jar", "app.jar"]
