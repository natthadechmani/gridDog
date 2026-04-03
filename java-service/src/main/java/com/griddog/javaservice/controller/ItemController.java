package com.griddog.javaservice.controller;

import com.griddog.javaservice.model.Item;
import com.griddog.javaservice.repository.ItemRepository;
import net.logstash.logback.argument.StructuredArguments;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

@RestController
public class ItemController {

    private static final Logger log = LoggerFactory.getLogger(ItemController.class);

    private final ItemRepository itemRepository;

    public ItemController(ItemRepository itemRepository) {
        this.itemRepository = itemRepository;
    }

    @GetMapping("/error/flaky")
    public ResponseEntity<Map<String, Object>> errorFlaky() {
        long start = System.currentTimeMillis();
        log.info("GET /error/flaky",
                StructuredArguments.kv("path", "/error/flaky"));
        boolean fail = ThreadLocalRandom.current().nextBoolean();

        long duration = System.currentTimeMillis() - start;
        if (fail) {
            log.error("GET /error/flaky — 500 simulated flaky failure (50% roll failed)",
                    StructuredArguments.kv("path", "/error/flaky"),
                    StructuredArguments.kv("status", 500),
                    StructuredArguments.kv("duration_ms", duration));
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("error", "simulated flaky failure", "simulated", true));
        }

        log.info("GET /error/flaky — 200 ok (50% roll passed)",
                StructuredArguments.kv("path", "/error/flaky"),
                StructuredArguments.kv("status", 200),
                StructuredArguments.kv("duration_ms", duration));
        return ResponseEntity.ok(Map.of("message", "ok", "simulated", true));
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> health() {
        long start = System.currentTimeMillis();
        log.info("GET /health",
                StructuredArguments.kv("method", "GET"),
                StructuredArguments.kv("path", "/health"));

        Map<String, String> body = Map.of(
                "status", "ok",
                "service", "java-service"
        );

        long duration = System.currentTimeMillis() - start;
        log.info("GET /health — 200 ok",
                StructuredArguments.kv("path", "/health"),
                StructuredArguments.kv("status", 200),
                StructuredArguments.kv("duration_ms", duration));

        return ResponseEntity.ok(body);
    }

    @GetMapping("/items")
    public ResponseEntity<List<Item>> getAllItems() {
        long start = System.currentTimeMillis();
        log.info("GET /items",
                StructuredArguments.kv("method", "GET"),
                StructuredArguments.kv("path", "/items"));

        try {
            List<Item> items = itemRepository.findAll();

            long duration = System.currentTimeMillis() - start;
            log.info("GET /items — fetched " + items.size() + " item(s) from postgres",
                    StructuredArguments.kv("path", "/items"),
                    StructuredArguments.kv("status", 200),
                    StructuredArguments.kv("item_count", items.size()),
                    StructuredArguments.kv("duration_ms", duration));

            return ResponseEntity.ok(items);
        } catch (Exception ex) {
            long duration = System.currentTimeMillis() - start;
            log.error("GET /items — 500 unexpected error querying postgres",
                    StructuredArguments.kv("path", "/items"),
                    StructuredArguments.kv("status", 500),
                    StructuredArguments.kv("duration_ms", duration),
                    ex);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    @GetMapping("/items/{id}")
    public ResponseEntity<Object> getItemById(@PathVariable Long id) {
        long start = System.currentTimeMillis();
        log.info("GET /items/" + id,
                StructuredArguments.kv("method", "GET"),
                StructuredArguments.kv("path", "/items/" + id),
                StructuredArguments.kv("item_id", id));

        try {
            Optional<Item> found = itemRepository.findById(id);

            if (found.isEmpty()) {
                long duration = System.currentTimeMillis() - start;
                log.warn("GET /items/" + id + " — 404 item not found in postgres",
                        StructuredArguments.kv("path", "/items/" + id),
                        StructuredArguments.kv("status", 404),
                        StructuredArguments.kv("item_id", id),
                        StructuredArguments.kv("duration_ms", duration));

                Map<String, Object> errorBody = Map.of(
                        "error", "not_found",
                        "message", "Item with id " + id + " does not exist",
                        "item_id", id
                );
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body(errorBody);
            }

            Item item = found.get();
            long duration = System.currentTimeMillis() - start;
            log.info("GET /items/" + id + " — fetched item id=" + item.getId() + " name=" + item.getName() + " value=" + item.getValue(),
                    StructuredArguments.kv("path", "/items/" + id),
                    StructuredArguments.kv("status", 200),
                    StructuredArguments.kv("item_id", item.getId()),
                    StructuredArguments.kv("item_name", item.getName()),
                    StructuredArguments.kv("item_value", item.getValue()),
                    StructuredArguments.kv("duration_ms", duration));

            return ResponseEntity.ok(item);

        } catch (Exception ex) {
            long duration = System.currentTimeMillis() - start;
            log.error("GET /items/" + id + " — 500 unexpected error querying postgres",
                    StructuredArguments.kv("path", "/items/" + id),
                    StructuredArguments.kv("status", 500),
                    StructuredArguments.kv("item_id", id),
                    StructuredArguments.kv("duration_ms", duration),
                    ex);

            Map<String, Object> errorBody = Map.of(
                    "error", "internal_server_error",
                    "message", "An unexpected error occurred"
            );
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorBody);
        }
    }

    @PostMapping("/items")
    public ResponseEntity<Item> createItem() {
        long start = System.currentTimeMillis();
        log.info("POST /items",
                StructuredArguments.kv("method", "POST"),
                StructuredArguments.kv("path", "/items"));

        try {
            String shortUuid = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
            double randomValue = ThreadLocalRandom.current().nextDouble(1.0, 1000.0);
            // Round to 2 decimal places for readability
            double roundedValue = Math.round(randomValue * 100.0) / 100.0;

            Item item = new Item();
            item.setName("item-" + shortUuid);
            item.setValue(roundedValue);
            item.setCreatedAt(LocalDateTime.now());

            Item saved = itemRepository.save(item);

            long duration = System.currentTimeMillis() - start;
            log.info("POST /items — created item id=" + saved.getId() + " name=" + saved.getName() + " value=" + saved.getValue(),
                    StructuredArguments.kv("path", "/items"),
                    StructuredArguments.kv("status", 201),
                    StructuredArguments.kv("item_id", saved.getId()),
                    StructuredArguments.kv("item_name", saved.getName()),
                    StructuredArguments.kv("item_value", saved.getValue()),
                    StructuredArguments.kv("duration_ms", duration));

            return ResponseEntity.status(HttpStatus.CREATED).body(saved);

        } catch (Exception ex) {
            long duration = System.currentTimeMillis() - start;
            log.error("POST /items — 500 unexpected error inserting into postgres",
                    StructuredArguments.kv("path", "/items"),
                    StructuredArguments.kv("status", 500),
                    StructuredArguments.kv("duration_ms", duration),
                    ex);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
}
