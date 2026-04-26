# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS builder

WORKDIR /app

COPY dotnet-scheduler.csproj .
RUN dotnet restore

COPY . .
RUN dotnet publish -c Release -o /out

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:8.0

# Install the Datadog .NET tracer — uses the CLR Profiler API (native .so library).
# Unlike Java (-javaagent) or Node (--require), .NET requires a native package installed
# in the container. createLogPath.sh creates /var/log/datadog/dotnet with correct permissions.
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* \
    && curl -Lo /tmp/datadog-dotnet-apm.tar.gz \
       https://github.com/DataDog/dd-trace-dotnet/releases/download/v3.14.0/datadog-dotnet-apm-3.14.0.tar.gz \
    && mkdir -p /opt/datadog \
    && tar -C /opt/datadog -xzf /tmp/datadog-dotnet-apm.tar.gz \
    && rm /tmp/datadog-dotnet-apm.tar.gz \
    && sh /opt/datadog/createLogPath.sh

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /app
COPY --from=builder /out .

# Give appuser write access to the Datadog log directory
RUN chown -R appuser:appgroup /var/log/datadog/dotnet

USER appuser

EXPOSE 5000

# Required env vars to activate the CLR profiler at runtime
ENV CORECLR_ENABLE_PROFILING=1
ENV CORECLR_PROFILER={846F5F1C-F9AE-4B07-969E-05C26BC060D8}
ENV CORECLR_PROFILER_PATH=/opt/datadog/Datadog.Trace.ClrProfiler.Native.so
ENV DD_DOTNET_TRACER_HOME=/opt/datadog

ENTRYPOINT ["dotnet", "dotnet-scheduler.dll"]
