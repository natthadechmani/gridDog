using Npgsql;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole();

var app = builder.Build();

var connectionString = Environment.GetEnvironmentVariable("DATABASE_URL")
    ?? throw new InvalidOperationException("DATABASE_URL environment variable is not set");

var logger = app.Logger;
logger.LogInformation("dotnet-scheduler starting on port {Port}",
    Environment.GetEnvironmentVariable("PORT") ?? "5000");

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.MapPost("/cleanup", async () =>
{
    logger.LogInformation("cleanup: received request — DELETE FROM items WHERE id != 1");
    try
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM items WHERE id != 1";
        var deleted = await cmd.ExecuteNonQueryAsync();
        logger.LogInformation("cleanup: deleted {Count} rows from items table", deleted);
        return Results.Ok(new { deleted });
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "cleanup: database error while deleting rows");
        return Results.Problem("Database error: " + ex.Message);
    }
});

var port = Environment.GetEnvironmentVariable("PORT") ?? "5000";
app.Run($"http://0.0.0.0:{port}");
