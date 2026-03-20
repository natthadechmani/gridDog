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

    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> health() {
        long start = System.currentTimeMillis();
        log.info("Request received",
                StructuredArguments.kv("method", "GET"),
                StructuredArguments.kv("path", "/health"));

        Map<String, String> body = Map.of(
                "status", "ok",
                "service", "java-service"
        );

        long duration = System.currentTimeMillis() - start;
        log.info("Request completed",
                StructuredArguments.kv("method", "GET"),
                StructuredArguments.kv("path", "/health"),
                StructuredArguments.kv("status", 200),
                StructuredArguments.kv("duration_ms", duration));

        return ResponseEntity.ok(body);
    }

    @GetMapping("/items")
    public ResponseEntity<List<Item>> getAllItems() {
        long start = System.currentTimeMillis();
        log.info("Request received",
                StructuredArguments.kv("method", "GET"),
                StructuredArguments.kv("path", "/items"));

        try {
            List<Item> items = itemRepository.findAll();

            long duration = System.currentTimeMillis() - start;
            log.info("Fetched all items",
                    StructuredArguments.kv("method", "GET"),
                    StructuredArguments.kv("path", "/items"),
                    StructuredArguments.kv("status", 200),
                    StructuredArguments.kv("item_count", items.size()),
                    StructuredArguments.kv("duration_ms", duration));

            return ResponseEntity.ok(items);
        } catch (Exception ex) {
            long duration = System.currentTimeMillis() - start;
            log.error("Unexpected error fetching items",
                    StructuredArguments.kv("method", "GET"),
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
        log.info("Request received",
                StructuredArguments.kv("method", "GET"),
                StructuredArguments.kv("path", "/items/" + id),
                StructuredArguments.kv("item_id", id));

        try {
            Optional<Item> found = itemRepository.findById(id);

            if (found.isEmpty()) {
                long duration = System.currentTimeMillis() - start;
                log.warn("Item not found",
                        StructuredArguments.kv("method", "GET"),
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

            long duration = System.currentTimeMillis() - start;
            log.info("Fetched item by id",
                    StructuredArguments.kv("method", "GET"),
                    StructuredArguments.kv("path", "/items/" + id),
                    StructuredArguments.kv("status", 200),
                    StructuredArguments.kv("item_id", id),
                    StructuredArguments.kv("duration_ms", duration));

            return ResponseEntity.ok(found.get());

        } catch (Exception ex) {
            long duration = System.currentTimeMillis() - start;
            log.error("Unexpected error fetching item",
                    StructuredArguments.kv("method", "GET"),
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
        log.info("Request received",
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
            log.info("Created new item",
                    StructuredArguments.kv("method", "POST"),
                    StructuredArguments.kv("path", "/items"),
                    StructuredArguments.kv("status", 201),
                    StructuredArguments.kv("item_id", saved.getId()),
                    StructuredArguments.kv("item_name", saved.getName()),
                    StructuredArguments.kv("item_value", saved.getValue()),
                    StructuredArguments.kv("duration_ms", duration));

            return ResponseEntity.status(HttpStatus.CREATED).body(saved);

        } catch (Exception ex) {
            long duration = System.currentTimeMillis() - start;
            log.error("Unexpected error creating item",
                    StructuredArguments.kv("method", "POST"),
                    StructuredArguments.kv("path", "/items"),
                    StructuredArguments.kv("status", 500),
                    StructuredArguments.kv("duration_ms", duration),
                    ex);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
}
