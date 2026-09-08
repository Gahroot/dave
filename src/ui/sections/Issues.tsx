import { Badge, Group, Stack, Table, Text, Title } from "@mantine/core";
import type { PortfolioIssue } from "../../shared/types.ts";

export function Issues({ issues }: { issues: PortfolioIssue[] }) {
  return (
    <Stack gap="sm">
      <Group gap="xs">
        <Title order={2}>Read issues</Title>
        <Badge variant="light" color={issues.length ? "red" : "green"}>
          {issues.length}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed">
        Sources that could not be read. Each one costs only its own data.
      </Text>
      {issues.length > 0 && (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={160}>Adapter</Table.Th>
              <Table.Th>Message</Table.Th>
              <Table.Th>Path</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {issues.map((issue, i) => (
              <Table.Tr key={i}>
                <Table.Td>{issue.adapter}</Table.Td>
                <Table.Td>{issue.message}</Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {issue.path ?? "—"}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
