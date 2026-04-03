package com.griddog.javaservice.controller;

import com.griddog.javaservice.model.PromoCode;
import com.griddog.javaservice.repository.PromoCodeRepository;
import net.logstash.logback.argument.StructuredArguments;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.Optional;

@RestController
public class PromoController {

    private static final Logger log = LoggerFactory.getLogger(PromoController.class);

    private final PromoCodeRepository promoCodeRepository;

    public PromoController(PromoCodeRepository promoCodeRepository) {
        this.promoCodeRepository = promoCodeRepository;
    }

    @GetMapping("/promo/verify/{code}")
    public ResponseEntity<Map<String, Object>> verifyPromo(@PathVariable String code) {
        long start = System.currentTimeMillis();
        log.info("GET /promo/verify/" + code,
                StructuredArguments.kv("method", "GET"),
                StructuredArguments.kv("path", "/promo/verify/" + code),
                StructuredArguments.kv("promo_code", code));

        try {
            Optional<PromoCode> found = promoCodeRepository.findByCodeIgnoreCase(code);

            long duration = System.currentTimeMillis() - start;

            if (found.isEmpty() || !Boolean.TRUE.equals(found.get().getIsActive())) {
                log.warn("GET /promo/verify/" + code + " — promo code invalid or inactive",
                        StructuredArguments.kv("path", "/promo/verify/" + code),
                        StructuredArguments.kv("promo_code", code),
                        StructuredArguments.kv("status", 200),
                        StructuredArguments.kv("valid", false),
                        StructuredArguments.kv("duration_ms", duration));

                return ResponseEntity.ok(Map.of(
                        "valid", false,
                        "reason", "code not found or inactive"
                ));
            }

            PromoCode promo = found.get();
            log.info("GET /promo/verify/" + code + " — promo code " + promo.getCode() + " verified, " + promo.getDiscountPercent() + "% discount",
                    StructuredArguments.kv("path", "/promo/verify/" + code),
                    StructuredArguments.kv("promo_code", promo.getCode()),
                    StructuredArguments.kv("discount_percent", promo.getDiscountPercent()),
                    StructuredArguments.kv("status", 200),
                    StructuredArguments.kv("valid", true),
                    StructuredArguments.kv("duration_ms", duration));

            return ResponseEntity.ok(Map.of(
                    "valid", true,
                    "code", promo.getCode(),
                    "discount_percent", promo.getDiscountPercent()
            ));

        } catch (Exception ex) {
            long duration = System.currentTimeMillis() - start;
            log.error("GET /promo/verify/" + code + " — 500 unexpected error querying postgres",
                    StructuredArguments.kv("path", "/promo/verify/" + code),
                    StructuredArguments.kv("promo_code", code),
                    StructuredArguments.kv("status", 500),
                    StructuredArguments.kv("duration_ms", duration),
                    ex);
            return ResponseEntity.internalServerError().body(Map.of(
                    "error", "internal_server_error",
                    "message", "An unexpected error occurred while verifying the promo code"
            ));
        }
    }
}
